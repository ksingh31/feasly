/**
 * Sheets sync worker state store tests (admin/04).
 *
 * The store runs against PGlite with the real migrations applied — so this
 * also pins migration 0022 (`sheets_sync_state` table). Covers: get creates
 * the singleton row on a fresh DB, update patches fields, and the lagging
 * flag round-trips (it is the `sheets_sync.lagging` metric from AC4).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createDrizzleSheetsSyncStateStore } from '../src/services/sheets-sync-state.store';
import { createTestDb, type TestDb } from './pglite-db';

describe('sheets sync state store (PGlite)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    // PGlite WASM init + migrations can exceed vitest's 10s default hook
    // timeout on cold/loaded machines.
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('get creates the singleton row on a fresh database', async () => {
    const store = createDrizzleSheetsSyncStateStore({ db: testDb.db });
    const state = await store.get();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lagging).toBe(false);
    expect(state.rowsSyncedTotal).toBe(0);
    expect(state.lastRunAt).toBeNull();
    expect(state.lastSuccessAt).toBeNull();
    expect(state.firstFailureAt).toBeNull();
  });

  it('update patches only the provided fields', async () => {
    const store = createDrizzleSheetsSyncStateStore({ db: testDb.db });
    const now = new Date('2026-09-25T01:00:00Z');
    const updated = await store.update({
      lastRunAt: now,
      consecutiveFailures: 2,
      lagging: false,
    });
    expect(updated.lastRunAt?.toISOString()).toBe(now.toISOString());
    expect(updated.consecutiveFailures).toBe(2);
    expect(updated.lagging).toBe(false);
    // Untouched fields keep their values.
    expect(updated.rowsSyncedTotal).toBe(0);
    expect(updated.lastSuccessAt).toBeNull();
  });

  it('round-trips the lagging flag (the sheets_sync.lagging metric)', async () => {
    const store = createDrizzleSheetsSyncStateStore({ db: testDb.db });
    await store.update({
      consecutiveFailures: 3,
      firstFailureAt: new Date('2026-09-25T00:00:00Z'),
      lagging: true,
    });
    const state = await store.get();
    expect(state.lagging).toBe(true);
    expect(state.consecutiveFailures).toBe(3);
    expect(state.firstFailureAt?.toISOString()).toBe(
      '2026-09-25T00:00:00.000Z',
    );

    // Recovery clears it.
    await store.update({
      consecutiveFailures: 0,
      firstFailureAt: null,
      lagging: false,
      lastSuccessAt: new Date('2026-09-25T02:00:00Z'),
    });
    const recovered = await store.get();
    expect(recovered.lagging).toBe(false);
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.firstFailureAt).toBeNull();
  });
});
