/**
 * Regression test for the 2026-09-28 builder sign-in 403
 * ("We couldn't find your Feasly builder account") — repair-guard edition.
 *
 * Migration 0042 grants the protected super_admin seed user
 * (karanbirsingh667@gmail.com) builder_admin on Elite Craft Builders, but
 * drizzle-kit silently skipped 0042 on dev while the journal claimed it
 * applied — so the membership row never materialized and the builder Entra
 * callback kept 403ing at the membership gate. The idempotent guard in
 * tools/repair-sql.mjs re-applies 0042's INSERT on every deploy through a
 * direct pg client (bypassing drizzle-kit), and is a no-op when the row
 * already exists.
 *
 * This test pins, against a PGlite database with all migrations applied:
 * - deleting the membership row (simulating the skipped migration), then
 *   running REPAIR_SQL, restores exactly one builder_admin membership for
 *   the protected user on elite-craft-builders;
 * - running REPAIR_SQL again creates no duplicates (idempotent).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './pglite-db';
// @ts-expect-error: plain .mjs module without type declarations
import { REPAIR_SQL } from '../tools/repair-sql.mjs';

const ADMIN_EMAIL = 'karanbirsingh667@gmail.com';
const TENANT_KEY = 'elite-craft-builders';

describe('builder QA membership repair guard', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    // PGlite WASM init + migrations can exceed vitest's 10s default hook
    // timeout on cold/loaded machines.
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  const memberships = () =>
    testDb.rows<{ email: string; tenant_key: string; role: string }>(
      `SELECT u.email, b.tenant_key, m.role
         FROM builder_memberships m
         JOIN users u ON u.id = m.user_id
         JOIN builders b ON b.id = m.builder_id
        WHERE u.email = '${ADMIN_EMAIL}'`,
    );

  it('restores the membership when the migration was silently skipped', async () => {
    // Simulate drizzle-kit skipping 0042: the user row exists, the
    // membership row does not.
    await testDb.rows(
      `DELETE FROM builder_memberships m USING users u
        WHERE m.user_id = u.id AND u.email = '${ADMIN_EMAIL}'`,
    );
    expect(await memberships()).toHaveLength(0);

    await testDb.exec(REPAIR_SQL as string);

    const rows = await memberships();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_key).toBe(TENANT_KEY);
    expect(rows[0].role).toBe('builder_admin');
  });

  it('is idempotent: re-running the repair creates no duplicates', async () => {
    await testDb.exec(REPAIR_SQL as string);
    expect(await memberships()).toHaveLength(1);
  });
});
