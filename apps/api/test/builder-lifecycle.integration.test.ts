/**
 * #860 — builder lifecycle against PGlite (every migration applied).
 *
 * Real BuilderLifecycleService + real BuilderService; only the audit store
 * and the card detach are fakes. Proves (AC1–AC5 at the API level):
 * - every status change needs a reason, records reason/when/who on the row
 *   and writes an audit row with the real admin identity;
 * - suspend → reactivate restores 'active' with nothing else touched;
 * - illegal transitions are 409; repeats are idempotent no-ops;
 * - complete offboarding is refused with the blockers listed while an
 *   invoice is unpaid or a dispute is open; once settled it succeeds,
 *   revokes sessions + builder-bound API keys and detaches the card;
 * - attribution rows (the 12-month tail) and invoices survive offboarding;
 * - the CSV export covers only that builder's leads / invoices;
 * - migration 0067 maps legacy 'inactive' to 'suspended' (repair SQL too).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createBuilderLifecycleService,
  type BuilderLifecycleService,
} from '../src/services/builder-lifecycle.service';
import { createBuilderService } from '../src/services/builder.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';
import { builders } from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const A = '8c1f3c2e-8d4a-4f61-9a1b-2c3d4e5f6a01';
const B = '8c1f3c2e-8d4a-4f61-9a1b-2c3d4e5f6a02';
const ADMIN = 'ops-admin@feasly.example';

describe('builder lifecycle (PGlite)', () => {
  let testDb: TestDb;
  let service: BuilderLifecycleService;
  const auditLog = vi.fn(async () => undefined);
  const detachCard = vi.fn(async () => undefined);

  beforeAll(async () => {
    testDb = await createTestDb();
    await testDb.db.insert(builders).values([
      { id: A, tenantKey: 'builder-a', businessName: 'A Ltd.', displayName: 'Builder A' },
      { id: B, tenantKey: 'builder-b', businessName: 'B Ltd.', displayName: 'Builder B' },
    ]);
    // Fixture rows only: skip FK checks so invoices/leads/attributions can
    // be inserted without the full estimate → lead → attribution chain.
    await testDb.exec(`SET session_replication_role = replica;`);
    await testDb.exec(`
      INSERT INTO tenants (tenant_key, business_name, display_name, accent_color, allowed_origins)
        VALUES ('builder-a','A Ltd.','Builder A','', '{}'), ('builder-b','B Ltd.','Builder B','', '{}');
      INSERT INTO leads (id, estimate_id, address_key, email, name, timeline, consent_ts, builder_id, tenant_key, source, created_at)
        VALUES
        ('11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-0000000000e1', '123 Main St NW', 'pat@home.example', 'Pat =HYPERLINK', 'asap', now(), '${A}', 'builder-a', 'embed', '2026-11-01T00:00:00Z'),
        ('11111111-0000-4000-8000-000000000002', '11111111-0000-4000-8000-0000000000e2', '9 Other Ave', 'sam@home.example', 'Sam', 'asap', now(), '${B}', 'builder-b', 'embed', '2026-11-02T00:00:00Z');
      INSERT INTO attribution_events (id, lead_id, tenant_key, introduced_at)
        VALUES ('22222222-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'builder-a', '2026-11-01T00:00:00Z');
      INSERT INTO commission_invoices (id, tenant_key, attribution_id, lead_id, contract_value_cents, commission_cents, status, invoice_number)
        VALUES ('33333333-0000-4000-8000-000000000001', 'builder-a', '22222222-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 50000000, 500000, 'in_review', 'FEAS-0001');
      INSERT INTO billing_disputes (id, invoice_id, tenant_key, reason, evidence_snapshot, status, sla_due_at)
        VALUES ('44444444-0000-4000-8000-000000000001', '33333333-0000-4000-8000-000000000001', 'builder-a', 'Wrong amount', '{}'::jsonb, 'open', '2026-11-23T00:00:00Z');
      INSERT INTO builder_sessions (id, email, tenant_key, builder_id, session_token_hash, expires_at)
        VALUES
        ('55555555-0000-4000-8000-000000000001', 'owner@a.example', 'builder-a', '${A}', 'hash-a1', '2026-12-01T00:00:00Z'),
        ('55555555-0000-4000-8000-000000000002', 'owner@b.example', 'builder-b', '${B}', 'hash-b1', '2026-12-01T00:00:00Z');
      INSERT INTO api_keys (id, name, tenant_id, key_hash, key_prefix, scopes)
        VALUES
        ('66666666-0000-4000-8000-000000000001', 'A prod', 'builder-a', 'khash-a', 'feasly_live_…aaaa', '{estimates:read}'),
        ('66666666-0000-4000-8000-000000000002', 'B prod', 'builder-b', 'khash-b', 'feasly_live_…bbbb', '{estimates:read}');
    `);
    await testDb.exec(`SET session_replication_role = origin;`);
    service = createBuilderLifecycleService({
      db: testDb.db,
      audit: { log: auditLog } as unknown as AdminAuditStore,
      detachCard,
      clock: () => NOW,
    });
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  async function statusOf(id: string): Promise<Record<string, unknown>> {
    const [row] = await testDb.rows<Record<string, unknown>>(
      `select status, status_reason, status_changed_by from builders where id = '${id}'`,
    );
    return row!;
  }

  it('requires a reason', async () => {
    await expect(service.changeStatus(A, 'suspend', '  ', ADMIN)).rejects.toMatchObject({
      status: 400,
    });
    expect((await statusOf(A))['status']).toBe('active');
  });

  it('suspend records reason/who/when and audits with the admin identity; repeat is a no-op', async () => {
    const res = await service.changeStatus(A, 'suspend', 'Card declined twice', ADMIN);
    expect(res.changed).toBe(true);
    expect(res.builder).toMatchObject({
      status: 'suspended',
      statusReason: 'Card declined twice',
      statusChangedBy: ADMIN,
      statusChangedAt: NOW.toISOString(),
    });
    expect(auditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actorEmail: ADMIN,
        action: 'admin_builder_suspended',
        detail: expect.stringContaining('from=active to=suspended'),
      }),
    );
    const calls = auditLog.mock.calls.length;
    const again = await service.changeStatus(A, 'suspend', 'Again', ADMIN);
    expect(again.changed).toBe(false);
    expect(auditLog.mock.calls.length).toBe(calls);
  });

  it('reactivate restores active without touching data', async () => {
    const res = await service.changeStatus(A, 'reactivate', 'Paid up', ADMIN);
    expect(res.builder.status).toBe('active');
    const [{ n }] = (await testDb.rows<{ n: number }>(
      `select count(*)::int as n from builder_sessions where revoked_at is null and builder_id = '${A}'`,
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('refuses illegal transitions with 409', async () => {
    await expect(
      service.changeStatus(A, 'complete_offboarding', 'Skip ahead', ADMIN),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('complete offboarding is blocked while an invoice is unpaid or a dispute is open', async () => {
    await service.changeStatus(A, 'start_offboarding', 'Builder asked to close', ADMIN);
    const blockers = await service.offboardingBlockers(A);
    expect(blockers.map((b) => b.kind).sort()).toEqual(['open_dispute', 'unpaid_invoice']);
    const err = await service
      .changeStatus(A, 'complete_offboarding', 'Done', ADMIN)
      .then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'OFFBOARDING_BLOCKED' });
    expect(String((err as Error).message)).toContain('FEAS-0001');
    expect((await statusOf(A))['status']).toBe('offboarding');
    expect(detachCard).not.toHaveBeenCalled();
  });

  it('once settled, completes: revokes sessions + keys, detaches the card, keeps attribution + invoices', async () => {
    await testDb.exec(`
      UPDATE billing_disputes SET status = 'rejected' WHERE tenant_key = 'builder-a';
      UPDATE commission_invoices SET status = 'paid', paid_at = now() WHERE tenant_key = 'builder-a';
    `);
    const res = await service.changeStatus(A, 'complete_offboarding', 'All settled', ADMIN);
    expect(res.builder.status).toBe('offboarded');
    expect(res.offboarding).toEqual({ sessionsRevoked: 1, apiKeysRevoked: 1, cardDetached: true });
    expect(detachCard).toHaveBeenCalledWith('builder-a');
    const live = await testDb.rows<{ tenant_key: string }>(
      `select tenant_key from builder_sessions where revoked_at is null`,
    );
    expect(live.map((r) => r.tenant_key)).toEqual(['builder-b']);
    const keys = await testDb.rows<{ tenant_id: string }>(
      `select tenant_id from api_keys where revoked_at is null`,
    );
    expect(keys.map((r) => r.tenant_id)).toEqual(['builder-b']);
    const [{ n: attributions }] = (await testDb.rows<{ n: number }>(
      `select count(*)::int as n from attribution_events where tenant_key = 'builder-a'`,
    )) as [{ n: number }];
    expect(attributions).toBe(1);
    expect(auditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorEmail: ADMIN, action: 'admin_builder_offboarded' }),
    );
    // Offboarded is terminal for reactivate.
    await expect(service.changeStatus(A, 'reactivate', 'Undo', ADMIN)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('a failing card detach is reported, not fatal', async () => {
    const failing = createBuilderLifecycleService({
      db: testDb.db,
      audit: { log: auditLog } as unknown as AdminAuditStore,
      detachCard: async () => {
        throw new Error('stripe down');
      },
      clock: () => NOW,
      logWarning: () => undefined,
    });
    await failing.changeStatus(B, 'start_offboarding', 'Closing', ADMIN);
    const res = await failing.changeStatus(B, 'complete_offboarding', 'Closing', ADMIN);
    expect(res.offboarding?.cardDetached).toBe(false);
  });

  it('a failure after the status commit is finished by retrying complete_offboarding', async () => {
    const C = '8c1f3c2e-8d4a-4f61-9a1b-2c3d4e5f6a04';
    await testDb.db.insert(builders).values({
      id: C, tenantKey: 'builder-c', businessName: 'C Ltd.', displayName: 'Builder C',
    });
    await testDb.exec(`
      INSERT INTO tenants (tenant_key, business_name, display_name, accent_color, allowed_origins)
        VALUES ('builder-c','C Ltd.','Builder C','', '{}');
      INSERT INTO builder_sessions (id, email, tenant_key, builder_id, session_token_hash, expires_at)
        VALUES ('55555555-0000-4000-8000-000000000003', 'owner@c.example', 'builder-c', '${C}', 'hash-c1', '2026-12-01T00:00:00Z');
    `);
    const flakyAudit = vi.fn(async (entry: { action: string }) => {
      if (entry.action === 'admin_builder_offboarded' && flakyAudit.mock.calls.length === 2) {
        throw new Error('db timeout');
      }
    });
    const detach = vi.fn(async () => undefined);
    const svc = createBuilderLifecycleService({
      db: testDb.db,
      audit: { log: flakyAudit } as unknown as AdminAuditStore,
      detachCard: detach,
      clock: () => NOW,
    });
    await svc.changeStatus(C, 'start_offboarding', 'Closing down', ADMIN);
    await expect(svc.changeStatus(C, 'complete_offboarding', 'Closing down', ADMIN)).rejects.toThrow(
      'db timeout',
    );
    // Status and revoke committed together.
    expect((await statusOf(C))['status']).toBe('offboarded');
    const live = await testDb.rows<{ n: number }>(
      `select count(*)::int as n from builder_sessions where revoked_at is null and builder_id = '${C}'`,
    );
    expect(live[0]?.n).toBe(0);

    const retry = await svc.changeStatus(C, 'complete_offboarding', 'Closing down', ADMIN);
    expect(retry.changed).toBe(false);
    expect(retry.offboarding).toEqual({ sessionsRevoked: 0, apiKeysRevoked: 0, cardDetached: true });
    expect(detach).toHaveBeenCalledTimes(2);
    expect(flakyAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'admin_builder_offboarded',
        detail: expect.stringContaining('retry=true'),
      }),
    );
  });

  it('keeps the free-text reason out of audit detail', () => {
    for (const [entry] of auditLog.mock.calls as unknown as [{ detail: string }][]) {
      expect(entry.detail).not.toContain('reason=');
    }
  });

  it('exports only that builder\'s leads and invoices as safe CSV', async () => {
    const leadsCsv = await service.exportCsv(A, 'leads', ADMIN);
    expect(leadsCsv.filename).toBe('builder-a-leads-2026-11-16.csv');
    const lines = leadsCsv.csv.trim().split('\n');
    expect(lines[0]).toBe('lead_id,created_at,name,email,phone,address,status,source,timeline');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('pat@home.example');
    expect(leadsCsv.csv).not.toContain('sam@home.example');
    const invoicesCsv = await service.exportCsv(A, 'invoices', ADMIN);
    expect(invoicesCsv.csv).toContain('FEAS-0001');
    expect(invoicesCsv.csv.trim().split('\n')).toHaveLength(2);
    expect(auditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'admin_builder_exported',
        detail: expect.stringContaining('kind=invoices rows=1'),
      }),
    );
    await expect(service.exportCsv('8c1f3c2e-8d4a-4f61-9a1b-2c3d4e5f6aff', 'leads', ADMIN))
      .rejects.toMatchObject({ status: 404 });
  });

  it('PATCH/create refuse a status change without the lifecycle endpoint', async () => {
    const bs = createBuilderService({ db: testDb.db, audit: { log: auditLog } as unknown as AdminAuditStore });
    await expect(bs.updateBuilder(B, { status: 'active' }, ADMIN)).rejects.toMatchObject({
      status: 400,
    });
    // Sending the current status (the drawer round-trips it) is fine.
    await expect(bs.updateBuilder(B, { status: 'offboarded', displayName: 'B2' }, ADMIN))
      .resolves.toMatchObject({ status: 'offboarded', displayName: 'B2' });
    await expect(
      bs.createBuilder(
        { tenantKey: 'new-one', businessName: 'N', displayName: 'N', status: 'suspended' },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('migration/repair map legacy inactive to suspended', async () => {
    await testDb.exec(
      `INSERT INTO builders (id, tenant_key, business_name, display_name, status)
         VALUES ('8c1f3c2e-8d4a-4f61-9a1b-2c3d4e5f6a03', 'legacy', 'L', 'L', 'inactive');`,
    );
    const repair = readFileSync(
      join(__dirname, '..', 'tools', 'repair-sql.d', '0860-builder-lifecycle.sql'),
      'utf8',
    );
    await testDb.exec(repair);
    expect((await statusOf('8c1f3c2e-8d4a-4f61-9a1b-2c3d4e5f6a03'))['status']).toBe('suspended');
  });
});
