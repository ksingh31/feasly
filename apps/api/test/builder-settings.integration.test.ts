/**
 * #870 — builder Settings against PGlite (every migration applied).
 *
 * Real BuilderService + real BuilderSettingsStore + real settings service;
 * only email and the audit store are fakes. Proves:
 * - an owner's profile update persists to `builders` AND the `tenants`
 *   mirror (the embed config reads it on the next load), audit-logged with
 *   the field names only;
 * - the embed endpoint reports each allowed origin's last `embed_loaded`
 *   and whether it falls inside the 7-day window (sandbox rows, other
 *   tenants, other events and non-allowed origins are ignored);
 * - an origin request creates exactly ONE `builder_change_requests` row
 *   and one team-inbox email, even when submitted twice;
 * - an admin update that applies the change closes the request.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createBuilderService } from '../src/services/builder.service';
import { createDrizzleBuilderSettingsStore } from '../src/services/builder-settings.store';
import {
  createBuilderSettingsService,
  type BuilderSettingsActor,
  type BuilderSettingsService,
} from '../src/services/builder-settings.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';
import { analyticsEvents, builders } from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const BUILDER_ID = '7b0f3c2e-8d4a-4f61-9a1b-2c3d4e5f6a7b';
const OTHER_ID = '7b0f3c2e-8d4a-4f61-9a1b-2c3d4e5f6a7c';
const DAY = 86_400_000;

describe('builder settings (PGlite)', () => {
  let testDb: TestDb;
  let service: BuilderSettingsService;
  let builderService: ReturnType<typeof createBuilderService>;
  const auditLog = vi.fn(async () => undefined);
  const sendOpsAlert = vi.fn(async () => ({ sent: true as const, provider: 'log' as const }));

  const owner: BuilderSettingsActor = {
    builderId: BUILDER_ID,
    userId: null,
    email: 'owner@builder-a.example',
    canEdit: true,
  };

  beforeAll(async () => {
    testDb = await createTestDb();
    await testDb.db.insert(builders).values([
      {
        id: BUILDER_ID,
        tenantKey: 'builder-a',
        businessName: 'Builder A Ltd.',
        displayName: 'Builder A',
        allowedOrigins: ['https://www.builder-a.example', 'https://staging.builder-a.example'],
        accentColor: '#112233',
      },
      {
        id: OTHER_ID,
        tenantKey: 'builder-b',
        businessName: 'Builder B Ltd.',
        displayName: 'Builder B',
        allowedOrigins: ['https://www.builder-a.example'],
      },
    ]);
    const audit = { log: auditLog } as unknown as AdminAuditStore;
    builderService = createBuilderService({
      db: testDb.db,
      audit,
      onAllowedOriginsChanged: async (args) => {
        await service.resolveSatisfiedOriginRequests(args);
      },
    });
    service = createBuilderSettingsService({
      builders: builderService,
      store: createDrizzleBuilderSettingsStore({ db: testDb.db }),
      audit,
      email: { sendOpsAlert },
      clock: () => NOW,
      config: {
        supportEmail: 'help@support.example',
        supportResponseTime: 'within 1 business day',
        embedLiveWindowDays: 7,
        embedLoaderUrl: 'https://app.example/embed/v1/loader.js',
        opsInbox: 'team@ops.example',
        appBaseUrl: 'https://app.example',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  it('persists an owner profile update to builders and the tenants mirror', async () => {
    const res = await service.updateProfile(owner, {
      displayName: 'Builder A Homes',
      contactEmail: 'Hello@Builder-A.example',
      contactPhone: '403-555-0100',
      logoUrl: 'https://cdn.builder-a.example/logo.png',
      accentColor: '#AABBCC',
    });
    expect(res.profile).toMatchObject({
      tenantKey: 'builder-a',
      displayName: 'Builder A Homes',
      contactEmail: 'hello@builder-a.example',
      contactPhone: '403-555-0100',
      logoUrl: 'https://cdn.builder-a.example/logo.png',
      accentColor: '#aabbcc',
    });
    const [tenant] = await testDb.rows<Record<string, unknown>>(
      `select display_name, logo_url, accent_color, fallback_email from tenants where tenant_key = 'builder-a'`,
    );
    expect(tenant).toEqual({
      display_name: 'Builder A Homes',
      logo_url: 'https://cdn.builder-a.example/logo.png',
      accent_color: '#aabbcc',
      fallback_email: 'hello@builder-a.example',
    });
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorEmail: 'owner@builder-a.example',
        action: 'builder_profile_updated',
        detail: expect.stringContaining('fields=displayName,email,phone,logoUrl,accentColor'),
      }),
    );
    // No contact values in the audit detail.
    const details = auditLog.mock.calls.map((c) => JSON.stringify(c));
    expect(details.join(' ')).not.toContain('403-555-0100');
    expect(details.join(' ')).not.toContain('hello@builder-a.example');
  });

  it('reports per-origin last load and the 7-day live window', async () => {
    const base = {
      route: '/embed/builder-a',
      consentTs: NOW,
      ts: NOW,
    };
    await testDb.db.insert(analyticsEvents).values([
      // www: loaded 2 days ago (live) and 20 days ago (older).
      { ...base, id: randomUUID(), event: 'embed_loaded', tenantKey: 'builder-a', embedOrigin: 'https://www.builder-a.example', createdAt: new Date(NOW.getTime() - 2 * DAY) },
      { ...base, id: randomUUID(), event: 'embed_loaded', tenantKey: 'builder-a', embedOrigin: 'https://www.builder-a.example', createdAt: new Date(NOW.getTime() - 20 * DAY) },
      // staging: only 10 days ago (not live).
      { ...base, id: randomUUID(), event: 'embed_loaded', tenantKey: 'builder-a', embedOrigin: 'https://staging.builder-a.example', createdAt: new Date(NOW.getTime() - 10 * DAY) },
      // Ignored: sandbox, other tenant, other event, non-allowed origin.
      { ...base, id: randomUUID(), event: 'embed_loaded', tenantKey: 'builder-a', embedOrigin: 'https://staging.builder-a.example', sandbox: true, createdAt: new Date(NOW.getTime() - DAY) },
      { ...base, id: randomUUID(), event: 'embed_loaded', tenantKey: 'builder-b', embedOrigin: 'https://staging.builder-a.example', createdAt: new Date(NOW.getTime() - DAY) },
      { ...base, id: randomUUID(), event: 'step_view', tenantKey: 'builder-a', embedOrigin: 'https://staging.builder-a.example', createdAt: new Date(NOW.getTime() - DAY) },
      { ...base, id: randomUUID(), event: 'embed_loaded', tenantKey: 'builder-a', embedOrigin: 'https://evil.example', createdAt: new Date(NOW.getTime() - DAY) },
    ]);
    const res = await service.getEmbed(owner);
    expect(res.tenantKey).toBe('builder-a');
    expect(res.loaderUrl).toBe('https://app.example/embed/v1/loader.js');
    expect(res.snippet).toContain('data-builder="builder-a"');
    expect(res.liveWindowDays).toBe(7);
    expect(res.origins).toEqual([
      {
        origin: 'https://www.builder-a.example',
        lastSeenAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
        loadedRecently: true,
      },
      {
        origin: 'https://staging.builder-a.example',
        lastSeenAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
        loadedRecently: false,
      },
    ]);
    expect(res.lastSeenAt).toBe(new Date(NOW.getTime() - 2 * DAY).toISOString());
  });

  it('creates exactly one admin task per origin request, then closes it on apply', async () => {
    sendOpsAlert.mockClear();
    const body = { add: ['https://new.builder-a.example/'], note: 'New marketing site' };
    const first = await service.requestOriginChange(owner, body);
    const second = await service.requestOriginChange(owner, body);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.id).toBe(first.request.id);
    expect(first.request).toMatchObject({
      status: 'open',
      add: ['https://new.builder-a.example'],
      remove: [],
      note: 'New marketing site',
    });
    const rows = await testDb.rows<{ n: number }>(
      `select count(*)::int as n from builder_change_requests where builder_id = '${BUILDER_ID}'`,
    );
    expect(rows[0]?.n).toBe(1);
    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
    expect((await service.getEmbed(owner)).openRequests).toHaveLength(1);

    // Staff apply the change in the admin console → request closed.
    await builderService.updateBuilder(
      BUILDER_ID,
      {
        allowedOrigins: [
          'https://www.builder-a.example',
          'https://staging.builder-a.example',
          'https://new.builder-a.example',
        ],
      },
      'staff@feasly.example',
    );
    const [closed] = await testDb.rows<Record<string, unknown>>(
      `select status, resolved_by_email from builder_change_requests where id = '${first.request.id}'`,
    );
    expect(closed).toEqual({ status: 'done', resolved_by_email: 'staff@feasly.example' });
    expect((await service.getEmbed(owner)).openRequests).toEqual([]);
  });

  it('repair SQL fragment creates the same objects idempotently', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sqlText = readFileSync(
      join(__dirname, '..', 'tools', 'repair-sql.d', '0870-builder-settings.sql'),
      'utf8',
    );
    await testDb.exec(sqlText);
    await testDb.exec(sqlText);
    const cols = await testDb.rows<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'analytics_events' and column_name = 'embed_origin'`,
    );
    expect(cols).toHaveLength(1);
  });
});
