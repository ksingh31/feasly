/**
 * Admin audit store tests (neighbourhood/05).
 *
 * The store runs against PGlite with the real migrations applied — so this
 * also pins migration 0017 (admin_audit_log table + action index). Covers:
 * append persists the action/actor/detail, append works without a detail,
 * and recent() returns entries newest-first with a limit.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createDrizzleAdminAuditStore } from '../src/services/admin-audit.store';
import { adminAuditLog } from '../src/db/schema';
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
      actorEmail: 'admin',
      detail: 'refreshed=212 skipped=3 roll_year=2025',
    });

    expect(entry.id).toBeTruthy();
    expect(entry.action).toBe('community_stats_refresh_manual');
    expect(entry.actorEmail).toBe('admin');
    expect(entry.detail).toBe('refreshed=212 skipped=3 roll_year=2025');
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it('appends entries without a detail', async () => {
    const store = createDrizzleAdminAuditStore({ db: testDb.db });
    const entry = await store.append({
      action: 'community_stats_refresh_manual',
      actorEmail: 'admin',
    });
    expect(entry.detail).toBeNull();
  });

  it('recent() returns entries newest-first and honors the limit', async () => {
    const store = createDrizzleAdminAuditStore({ db: testDb.db });
    // Insert with explicit, distinct timestamps: two rapid appends can land
    // in the same DB timestamp tick, which makes ORDER BY created_at DESC
    // non-deterministic (flaked in CI as ['b','c','a'] vs ['c','b','a']).
    // Explicit timestamps keep this ordering test deterministic.
    const t0 = Date.now() + 60_000; // newer than rows written by earlier tests
    await testDb.db.insert(adminAuditLog).values(
      ['a', 'b', 'c'].map((action, i) => ({
        id: randomUUID(),
        action,
        actorEmail: 'admin',
        detail: null,
        createdAt: new Date(t0 + i * 1000),
      })),
    );

    const all = await store.recent(100);
    const actions = all.map((e) => e.action);
    expect(actions.slice(0, 3)).toEqual(['c', 'b', 'a']);

    const two = await store.recent(2);
    expect(two).toHaveLength(2);
    expect(two.map((e) => e.action)).toEqual(['c', 'b']);
  });
});
