/**
 * Funnel Drizzle store integration test (admin/07).
 *
 * Runs the real migration SQL against an in-process Postgres (PGlite),
 * seeds analytics_events rows directly, then exercises the real store:
 * grouped counts, date-range filtering, tenant filtering (tenant / direct /
 * all), and sandbox exclusion.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDrizzleFunnelStore } from '../src/services/funnel.store';
import { analyticsEvents } from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

const ALL = { kind: 'all' } as const;

async function seed(
  testDb: TestDb,
  rows: {
    event: string;
    route: string;
    tenantKey?: string | null;
    sandbox?: boolean;
    createdAt?: Date;
  }[],
): Promise<void> {
  const db = testDb.db as {
    insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> };
  };
  await db.insert(analyticsEvents).values(
    rows.map((r) => ({
      id: randomUUID(),
      event: r.event,
      route: r.route,
      ts: new Date('2026-09-20T12:00:00.000Z'),
      consentTs: new Date('2026-09-20T11:59:00.000Z'),
      tenantKey: r.tenantKey ?? null,
      sandbox: r.sandbox ?? false,
      createdAt: r.createdAt ?? new Date('2026-09-20T12:00:00.000Z'),
    })),
  );
}

describe('funnel store (PGlite)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('groups counts by (event, route)', async () => {
    const store = createDrizzleFunnelStore({ db: testDb.db });
    await seed(testDb, [
      { event: 'step_view', route: '/estimate/scope' },
      { event: 'step_view', route: '/estimate/scope' },
      { event: 'gate_view', route: '/estimate/gate' },
    ]);
    const rows = await store.countByEventRoute({ tenant: ALL });
    const byKey = new Map(rows.map((r) => [`${r.event} ${r.route}`, r.count]));
    expect(byKey.get('step_view /estimate/scope')).toBe(2);
    expect(byKey.get('gate_view /estimate/gate')).toBe(1);
  });

  it('excludes sandbox rows', async () => {
    const store = createDrizzleFunnelStore({ db: testDb.db });
    await seed(testDb, [
      { event: 'step_view', route: '/sandbox-step', sandbox: true },
      { event: 'step_view', route: '/sandbox-step' },
    ]);
    const rows = await store.countByEventRoute({ tenant: ALL });
    const row = rows.find((r) => r.route === '/sandbox-step');
    expect(row?.count).toBe(1);
  });

  it('filters by date range on created_at', async () => {
    const store = createDrizzleFunnelStore({ db: testDb.db });
    await seed(testDb, [
      {
        event: 'step_view',
        route: '/date-step',
        createdAt: new Date('2026-09-10T12:00:00.000Z'),
      },
      {
        event: 'step_view',
        route: '/date-step',
        createdAt: new Date('2026-09-25T12:00:00.000Z'),
      },
    ]);
    const rows = await store.countByEventRoute({
      tenant: ALL,
      from: new Date('2026-09-20T00:00:00.000Z'),
      to: new Date('2026-09-30T00:00:00.000Z'),
    });
    const row = rows.find((r) => r.route === '/date-step');
    expect(row?.count).toBe(1);
  });

  it('filters to one tenant, direct-only, or all', async () => {
    const store = createDrizzleFunnelStore({ db: testDb.db });
    await seed(testDb, [
      { event: 'step_view', route: '/tenant-step', tenantKey: 'acme' },
      { event: 'step_view', route: '/tenant-step', tenantKey: 'other' },
      { event: 'step_view', route: '/tenant-step' },
    ]);

    const tenantRows = await store.countByEventRoute({
      tenant: { kind: 'tenant', tenantKey: 'acme' },
    });
    expect(
      tenantRows.find((r) => r.route === '/tenant-step')?.count,
    ).toBe(1);

    const directRows = await store.countByEventRoute({
      tenant: { kind: 'direct' },
    });
    expect(directRows.find((r) => r.route === '/tenant-step')?.count).toBe(1);

    const allRows = await store.countByEventRoute({ tenant: ALL });
    expect(allRows.find((r) => r.route === '/tenant-step')?.count).toBe(3);
  });
});
