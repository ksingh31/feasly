/**
 * #840 — builder lead lists exclude sandbox (feasly_test_) leads, and the
 * sandbox purge runs in one transaction (PGlite, real migrations).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { builders } from '../src/db/schema';
import { createDrizzleEstimateStore } from '../src/services/estimate.store';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createDrizzleSandboxPurgeStore } from '../src/services/sandbox-purge.store';
import type { AppDb } from '../src/db/client';
import { createTestDb, type TestDb } from './pglite-db';

const TENANT_KEY = 'sandbox-840-builder';
const ADDRESS_KEY = 'calgary-840-sandbox-test';
const T1 = new Date('2026-09-24T12:00:00Z');

describe('lead store sandbox exclusions + transactional purge (#840)', () => {
  let testDb: TestDb;
  let builderId: string;
  let liveId: string;
  let sandboxId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    const estimates = createDrizzleEstimateStore({ db: testDb.db });
    const leads = createDrizzleLeadStore({ db: testDb.db });

    builderId = randomUUID();
    await testDb.db.insert(builders).values({
      id: builderId,
      tenantKey: TENANT_KEY,
      businessName: 'Sandbox 840',
      displayName: 'Sandbox 840',
    });

    const estimateId = randomUUID();
    await estimates.save({
      id: estimateId,
      projectType: 'new_build',
      addressKey: ADDRESS_KEY,
      inputs: {},
      figures: { total: { base: 1_200_000 } },
      rows: [],
      costDataVersion: 'v0.1.0-test',
      createdAt: T1,
      narrative: null,
      narrativeGeneratedAt: null,
      assumptions: null,
    });
    const sandboxEstimateId = randomUUID();
    await estimates.save({
      id: sandboxEstimateId,
      projectType: 'new_build',
      addressKey: ADDRESS_KEY,
      inputs: {},
      figures: { total: { base: 1_200_000 } },
      rows: [],
      costDataVersion: 'v0.1.0-test',
      createdAt: T1,
      narrative: null,
      narrativeGeneratedAt: null,
      assumptions: null,
      sandbox: true,
    });

    liveId = randomUUID();
    await leads.insert({
      id: liveId,
      estimateId,
      addressKey: ADDRESS_KEY,
      email: 'live-840@example.com',
      name: 'Live',
      timeline: 'exploring',
      marketingConsent: false,
      consentTs: T1,
      source: 'api',
      tenantKey: TENANT_KEY,
      builderId,
    });
    sandboxId = randomUUID();
    await leads.insert({
      id: sandboxId,
      estimateId: sandboxEstimateId,
      addressKey: ADDRESS_KEY,
      email: 'sandbox-840@example.com',
      name: 'Sandbox',
      timeline: 'exploring',
      marketingConsent: false,
      consentTs: T1,
      source: 'api',
      tenantKey: TENANT_KEY,
      builderId,
      sandbox: true,
    });
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  it('listByBuilderId excludes sandbox leads', async () => {
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const ids = (await leads.listByBuilderId({ builderId })).map((r) => r.id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(sandboxId);
  });

  it('listByTenantKey excludes sandbox leads', async () => {
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const ids = (await leads.listByTenantKey({ tenantKey: TENANT_KEY })).map((r) => r.id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(sandboxId);
  });

  it('rolls back every delete when a later purge step fails', async () => {
    // Fail the `leads` delete (after magic_links, analytics and the
    // dependents were already deleted inside the transaction).
    const realDb = testDb.db;
    const failingDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (fn: (tx: AppDb) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              let deletes = 0;
              const wrapped = new Proxy(tx, {
                get(t, p, r) {
                  if (p === 'delete') {
                    return (table: unknown) => {
                      deletes += 1;
                      // 6th delete = leads (magic_links, analytics_events,
                      // report_snapshots, callback_requests, partner_shares).
                      if (deletes === 6) {
                        throw new Error('simulated mid-purge failure');
                      }
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      return (t as any).delete(table);
                    };
                  }
                  return Reflect.get(t, p, r);
                },
              });
              return fn(wrapped as unknown as AppDb);
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    await testDb.rows(
      `insert into magic_links (id, lead_id, token_hash, purpose, expires_at, sandbox, created_at)
       values ('${randomUUID()}', '${sandboxId}', 'hash-840', 'report', now() + interval '1 day', true, '${T1.toISOString()}')`,
    );
    const before = await testDb.rows('select id from magic_links where sandbox = true');
    expect(before.length).toBeGreaterThan(0);

    await expect(
      createDrizzleSandboxPurgeStore({ db: failingDb }).purgeOldSandboxRows(
        new Date(Date.now() + 60_000),
      ),
    ).rejects.toThrow('simulated mid-purge failure');

    // Nothing was deleted: the earlier magic_links delete rolled back too.
    expect(await testDb.rows('select id from magic_links where sandbox = true')).toHaveLength(
      before.length,
    );
    expect(await testDb.rows(`select id from leads where id = '${sandboxId}'`)).toHaveLength(1);

    // The real store then purges cleanly.
    const counts = await createDrizzleSandboxPurgeStore({ db: realDb }).purgeOldSandboxRows(
      new Date(Date.now() + 60_000),
    );
    expect(counts.leads).toBe(1);
    expect(counts.magicLinks).toBeGreaterThanOrEqual(1);
    expect(await testDb.rows(`select id from leads where id = '${liveId}'`)).toHaveLength(1);
  });
});
