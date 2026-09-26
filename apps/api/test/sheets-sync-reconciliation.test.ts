/**
 * Sheets pending-count reconciliation tests (admin/05 AC1).
 *
 * The ops panel's `pending_count` must reconcile EXACTLY with the DB:
 * leads with `sheets_synced_at IS NULL`, excluding spam-quarantined rows
 * (they never sync). Seeded against PGlite with the real migrations, this
 * pins the `LeadStore.countNeverSynced` predicate against the raw SQL the
 * story names.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createDrizzleLeadStore,
  type NewLead,
} from '../src/services/lead.store';
import { estimates } from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

/** Seed one estimate so leads satisfy the estimate_id FK. */
async function seedEstimate(testDb: TestDb): Promise<string> {
  const id = randomUUID();
  await testDb.db.insert(estimates).values({
    id,
    addressKey: `seed ${Math.random().toString(36).slice(2)}`,
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'test',
  });
  return id;
}

function makeLead(
  estimateId: string,
  overrides: Partial<NewLead> = {},
): NewLead {
  const now = new Date();
  return {
    id: randomUUID(),
    estimateId,
    addressKey: `123 Test St Calgary ${Math.random().toString(36).slice(2)}`,
    email: `lead-${Math.random().toString(36).slice(2)}@example.com`,
    name: 'Test Lead',
    timeline: '3-6 months',
    marketingConsent: true,
    consentTs: now,
    source: 'web',
    ...overrides,
  };
}

describe('sheets pending-count reconciliation (admin/05 AC1)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('countNeverSynced matches the raw IS NULL predicate exactly', async () => {
    const store = createDrizzleLeadStore({ db: testDb.db });
    const estimateId = await seedEstimate(testDb);

    // 3 never-synced → pending.
    await store.insert(makeLead(estimateId));
    await store.insert(makeLead(estimateId));
    await store.insert(makeLead(estimateId));
    // 1 synced → not pending.
    const synced = await store.insert(makeLead(estimateId));
    await store.setSheetsSyncedAt({ id: synced.id, at: new Date() });
    // 1 quarantined (spam), never synced → NOT pending (never syncs).
    await store.insert(makeLead(estimateId, { quarantined: true }));

    const storeCount = await store.countNeverSynced();

    // The raw predicate the story names.
    const raw = await testDb.rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM leads
        WHERE quarantined = false AND sheets_synced_at IS NULL`,
    );
    const rawCount = Number(raw[0].n);

    expect(rawCount).toBe(3);
    expect(storeCount).toBe(rawCount);
  });
});
