/**
 * Sheets sync run-store tests (admin/05).
 *
 * The store runs against PGlite with the real migrations applied — this
 * also pins migration 0022 (sheets_sync_runs table + started_at index).
 * Covers: startRun inserts a 'running' row, finishRun stamps status/counts,
 * recent() is newest-first with a limit, totalSyncedRows sums successes
 * only, findInFlight finds fresh 'running' rows and ignores stale ones.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createDrizzleSheetsSyncRunStore,
  type SheetsSyncRunStore,
} from '../src/services/sheets-sync-run.store';
import { createTestDb, type TestDb } from './pglite-db';

describe('sheets sync run store', () => {
  let testDb: TestDb;
  let store: SheetsSyncRunStore;

  beforeAll(async () => {
    testDb = await createTestDb();
    store = createDrizzleSheetsSyncRunStore({ db: testDb.db });
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('pins migration 0022: the table and index exist', async () => {
    const tables = await testDb.rows<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'sheets_sync_runs'",
    );
    expect(tables).toHaveLength(1);
    const indexes = await testDb.rows<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'sheets_sync_runs'",
    );
    expect(indexes.map((i) => i.indexname)).toContain(
      'sheets_sync_runs_started_at_idx',
    );
  });

  it('startRun inserts a running row; finishRun stamps success', async () => {
    const run = await store.startRun({ trigger: 'manual', actorEmail: 'karanbirsingh667@gmail.com' });
    expect(run.status).toBe('running');
    expect(run.trigger).toBe('manual');
    expect(run.actorEmail).toBe('karanbirsingh667@gmail.com');
    expect(run.finishedAt).toBeNull();

    await store.finishRun({
      id: run.id,
      status: 'success',
      syncedCount: 7,
      skippedCount: 2,
    });

    const recent = await store.recent(1);
    expect(recent[0].status).toBe('success');
    expect(recent[0].syncedCount).toBe(7);
    expect(recent[0].skippedCount).toBe(2);
    expect(recent[0].finishedAt).toBeInstanceOf(Date);
  });

  it('finishRun records failures with the (already sanitized) error text', async () => {
    const run = await store.startRun({ trigger: 'timer' });
    await store.finishRun({
      id: run.id,
      status: 'failed',
      errorMessage: 'quota exceeded (429)',
    });
    const recent = await store.recent(1);
    expect(recent[0].status).toBe('failed');
    expect(recent[0].errorMessage).toBe('quota exceeded (429)');
  });

  it('recent() is newest-first and honors the limit', async () => {
    const a = await store.startRun({ trigger: 'timer' });
    const b = await store.startRun({ trigger: 'timer' });
    await store.finishRun({ id: a.id, status: 'success' });
    await store.finishRun({ id: b.id, status: 'success' });

    const recent = await store.recent(2);
    expect(recent.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('totalSyncedRows sums only successful runs', async () => {
    const before = await store.totalSyncedRows();
    const s = await store.startRun({ trigger: 'timer' });
    await store.finishRun({ id: s.id, status: 'success', syncedCount: 5 });
    const f = await store.startRun({ trigger: 'timer' });
    await store.finishRun({ id: f.id, status: 'failed', errorMessage: 'x' });
    const d = await store.startRun({ trigger: 'timer' });
    await store.finishRun({ id: d.id, status: 'disabled' });

    expect(await store.totalSyncedRows()).toBe(before + 5);
  });

  it('findInFlight returns the newest running row and ignores finished ones', async () => {
    const inFlight = await store.startRun({ trigger: 'manual' });
    const done = await store.startRun({ trigger: 'timer' });
    await store.finishRun({ id: done.id, status: 'success' });

    const found = await store.findInFlight(30);
    expect(found?.id).toBe(inFlight.id);

    await store.finishRun({ id: inFlight.id, status: 'success' });
    expect(await store.findInFlight(30)).toBeNull();
  });

  it('findInFlight treats rows older than the staleness window as stale', async () => {
    const stale = await store.startRun({ trigger: 'timer' });
    // Backdate started_at past the 30-minute staleness window.
    await testDb.rows(
      `UPDATE sheets_sync_runs SET started_at = now() - interval '31 minutes' WHERE id = '${stale.id}'`,
    );
    expect(await store.findInFlight(30)).toBeNull();
    // Sanity: the row is still 'running' — only the in-flight query ignores it.
    const rows = await testDb.rows<{ status: string }>(
      `SELECT status FROM sheets_sync_runs WHERE id = '${stale.id}'`,
    );
    expect(rows[0].status).toBe('running');
  });
});
