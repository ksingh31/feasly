/**
 * Regression test for the 2026-09-29 builder sign-in 500
 * ("insert or update on table builder_sessions violates foreign key
 * constraint builder_sessions_tenant_key_fkey") — tenants-seed edition.
 *
 * Migration 0006 created the `tenants` table and 0027 gave
 * `builder_sessions.tenant_key` an FK to `tenants(tenant_key)` — but no
 * migration ever seeded a tenant row. The first real builder Entra sign-in
 * (Karan's, 2026-09-29 02:18Z) got past the membership gate (restored by the
 * #354/#355 repair) and then 500'd in the callback at the session insert,
 * because `tenants` had no 'elite-craft-builders' row. The idempotent guard
 * in tools/repair-sql.mjs seeds the tenant rows on every deploy through a
 * direct pg client, and is a no-op when the rows already exist.
 *
 * This test pins, against a PGlite database with all migrations applied:
 * - deleting the tenant row (simulating the never-seeded state), then
 *   running REPAIR_SQL, restores the 'elite-craft-builders' tenant;
 * - the callback's session insert (tenant_key FK) succeeds afterwards —
 *   it failed with the FK violation before the seed;
 * - running REPAIR_SQL again creates no duplicates (idempotent).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './pglite-db';
// @ts-expect-error: plain .mjs module without type declarations
import { REPAIR_SQL } from '../tools/repair-sql.mjs';

const TENANT_KEY = 'elite-craft-builders';
const BUILDER_ID = 'a506cc36-ffd1-42db-993c-999bfbb0f1d2';

describe('builder tenants seed repair guard', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    // PGlite WASM init + migrations can exceed vitest's 10s default hook
    // timeout on cold/loaded machines.
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  const tenants = () =>
    testDb.rows<{ tenant_key: string }>(
      `SELECT tenant_key FROM tenants WHERE tenant_key = '${TENANT_KEY}'`,
    );

  it('restores the tenant row when it was never seeded', async () => {
    // Simulate the dev database state that 500'd the 2026-09-29 callback:
    // the tenants table exists (0006) but no migration ever seeded it.
    await testDb.rows(`DELETE FROM tenants WHERE tenant_key = '${TENANT_KEY}'`);
    expect(await tenants()).toHaveLength(0);

    await testDb.exec(REPAIR_SQL as string);

    const rows = await tenants();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_key).toBe(TENANT_KEY);
  });

  it('lets the callback session insert satisfy the tenant_key FK', async () => {
    // The exact insert the builder Entra callback performs (shape mirrored
    // from builder-entra-callback.service.ts) — this raised
    // builder_sessions_tenant_key_fkey before the tenants seed.
    const users = await testDb.rows<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email = 'karanbirsingh667@gmail.com'`,
    );
    expect(users).toHaveLength(1);
    await testDb.rows(
      `INSERT INTO builder_sessions
         (id, email, tenant_key, session_token_hash, user_id, builder_id, expires_at)
       VALUES
         (gen_random_uuid(), '${users[0]!.email}', '${TENANT_KEY}',
          'test-hash-' || gen_random_uuid()::text, '${users[0]!.id}',
          '${BUILDER_ID}', now() + interval '7 days')`,
    );
    const sessions = await testDb.rows<{ tenant_key: string }>(
      `SELECT tenant_key FROM builder_sessions WHERE tenant_key = '${TENANT_KEY}'`,
    );
    expect(sessions.length).toBeGreaterThan(0);
  });

  it('is idempotent: re-running the repair creates no duplicates', async () => {
    await testDb.exec(REPAIR_SQL as string);
    await testDb.exec(REPAIR_SQL as string);
    expect(await tenants()).toHaveLength(1);
  });
});
