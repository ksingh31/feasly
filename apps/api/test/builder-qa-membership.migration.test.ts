/**
 * Regression test for the 2026-09-28 builder sign-in 403
 * ("We couldn't find your Feasly builder account").
 *
 * The protected super_admin seed user (karanbirsingh667@gmail.com) had no
 * builder_memberships row: Entra sign-in succeeded, then the auth/05 callback
 * rejected with 403. Migration 0042 grants that user builder_admin on the
 * Elite Craft Builders tenant. This test pins, against the real applied
 * migrations:
 * - the protected admin user holds exactly one builder_admin membership on
 *   elite-craft-builders;
 * - migration 0042 is idempotent — re-running its SQL cannot create a
 *   duplicate membership.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './pglite-db';

const ADMIN_EMAIL = 'karanbirsingh667@gmail.com';
const TENANT_KEY = 'elite-craft-builders';

describe('0042 builder QA membership migration', () => {
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
         JOIN builders b ON b.id = m.builder_id`,
    );

  it('grants the protected admin user builder_admin on Elite Craft Builders', async () => {
    const rows = (await memberships()).filter(
      (r) => r.email === ADMIN_EMAIL && r.tenant_key === TENANT_KEY,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('builder_admin');
  });

  it('is idempotent: re-running the migration SQL creates no duplicates', async () => {
    const sql = readFileSync(
      join(__dirname, '..', 'src', 'db', 'migrations', '0042_builder_qa_membership.sql'),
      'utf8',
    );
    await testDb.rows(sql);
    const rows = await memberships();
    expect(rows.filter((r) => r.email === ADMIN_EMAIL)).toHaveLength(1);
  });
});
