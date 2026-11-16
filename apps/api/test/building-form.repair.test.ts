/**
 * #689: building-form columns + widened waitlist key, migration and repair.
 *
 * Migration 0055 adds `estimates.building_form` and
 * `waitlist_signups.building_form/district/community`, and swaps the
 * waitlist key (email, topic) → (email, topic, COALESCE(form, '')). If
 * drizzle-kit silently skips it, tools/repair-sql.mjs must land the same
 * end state — and re-running the repair must never bring the old narrow
 * key back (it would block a second form for the same email).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './pglite-db';
// @ts-expect-error: plain .mjs module without type declarations
import { REPAIR_SQL } from '../tools/repair-sql.mjs';

describe('building-form schema (#689)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  const waitlistIndexes = async (): Promise<string[]> =>
    (
      await testDb.rows<{ indexname: string }>(
        `select indexname from pg_indexes where tablename = 'waitlist_signups' order by indexname`,
      )
    ).map((r) => r.indexname);

  const columns = async (table: string): Promise<string[]> =>
    (
      await testDb.rows<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = '${table}'`,
      )
    ).map((r) => r.column_name);

  it('migrations add the nullable columns and the widened key only', async () => {
    expect(await columns('estimates')).toContain('building_form');
    expect(await columns('waitlist_signups')).toEqual(
      expect.arrayContaining(['building_form', 'district', 'community']),
    );
    const idx = await waitlistIndexes();
    expect(idx).toContain('waitlist_signups_email_topic_form_idx');
    expect(idx).not.toContain('waitlist_signups_email_topic_idx');
  });

  it('repair restores the end state after a skipped migration, idempotently', async () => {
    await testDb.exec(`DROP INDEX "waitlist_signups_email_topic_form_idx"`);
    await testDb.exec(`ALTER TABLE "waitlist_signups" DROP COLUMN "building_form"`);
    await testDb.exec(`ALTER TABLE "estimates" DROP COLUMN "building_form"`);
    await testDb.exec(
      `CREATE UNIQUE INDEX "waitlist_signups_email_topic_idx" ON "waitlist_signups" ("email","topic")`,
    );

    await testDb.exec(REPAIR_SQL as string);
    await testDb.exec(REPAIR_SQL as string);

    expect(await columns('estimates')).toContain('building_form');
    expect(await columns('waitlist_signups')).toContain('building_form');
    const idx = await waitlistIndexes();
    expect(idx).toContain('waitlist_signups_email_topic_form_idx');
    expect(idx).not.toContain('waitlist_signups_email_topic_idx');

    // Two forms for one email fit; a NULL-form repeat still collides.
    await testDb.exec(
      `insert into waitlist_signups (id, email, topic, building_form) values
        ('00000000-0000-4000-8000-000000000001', 'k@example.com', 'building-form', 'duplex'),
        ('00000000-0000-4000-8000-000000000002', 'k@example.com', 'building-form', 'rowhouse'),
        ('00000000-0000-4000-8000-000000000003', 'k@example.com', 'renovation', null)`,
    );
    await expect(
      testDb.exec(
        `insert into waitlist_signups (id, email, topic) values
          ('00000000-0000-4000-8000-000000000004', 'k@example.com', 'renovation')`,
      ),
    ).rejects.toThrow();
  });
});
