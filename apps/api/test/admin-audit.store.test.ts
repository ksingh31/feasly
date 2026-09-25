/**
 * Admin audit store tests (neighbourhood/05).
 *
 * The store runs against PGlite with the real migrations applied — so this
 * also pins migration 0017 (admin_audit_log table + action index). Covers:
 * append persists the action/actor/detail, append works without a detail,
 * and recent() returns entries newest-first with a limit.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createDrizzleAdminAuditStore } from '../src/services/admin-audit.store';
import { createTestDb, type TestDb } from './pglite-db';

describe('admin audit store', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    // PGlite WASM init + migrations can exceed vitest's 10s default hook
    // timeout on cold/loaded machines.
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('appends an entry with action, actor, and detail', async () => {
    const store = createDrizzleAdminAuditStore({ db: testDb.db });
    const entry = await store.append({
      action: 'community_stats_refresh_manual',
      actor: 'admin',
      detail: 'refreshed=212 skipped=3 roll_year=2025',
    });

    expect(entry.id).toBeTruthy();
    expect(entry.action).toBe('community_stats_refresh_manual');
    expect(entry.actor).toBe('admin');
    expect(entry.detail).toBe('refreshed=212 skipped=3 roll_year=2025');
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it('appends entries without a detail', async () => {
    const store = createDrizzleAdminAuditStore({ db: testDb.db });
    const entry = await store.append({
      action: 'community_stats_refresh_manual',
      actor: 'admin',
    });
    expect(entry.detail).toBeNull();
  });

  it('recent() returns entries newest-first and honors the limit', async () => {
    const store = createDrizzleAdminAuditStore({ db: testDb.db });
    await store.append({ action: 'a', actor: 'admin' });
    await store.append({ action: 'b', actor: 'admin' });
    await store.append({ action: 'c', actor: 'admin' });

    const all = await store.recent(100);
    const actions = all.map((e) => e.action);
    expect(actions.slice(0, 3)).toEqual(['c', 'b', 'a']);

    const two = await store.recent(2);
    expect(two).toHaveLength(2);
    expect(two.map((e) => e.action)).toEqual(['c', 'b']);
  });
});
