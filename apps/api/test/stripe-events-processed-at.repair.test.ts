/**
 * #711: `stripe_events.processed_at` repair guard.
 *
 * If drizzle-kit silently skips migration 0048, tools/repair-sql.mjs adds
 * the column and backfills pre-existing (already handled) events as
 * processed — otherwise every old event would re-run its handler on a
 * Stripe redelivery and show as "unprocessed" on /admin/webhooks. Re-running
 * the repair must NEVER mark a genuinely unprocessed event as done.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './pglite-db';
// @ts-expect-error: plain .mjs module without type declarations
import { REPAIR_SQL } from '../tools/repair-sql.mjs';

describe('stripe_events.processed_at repair guard (#711)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  const processedAt = async (eventId: string) =>
    (
      await testDb.rows<{ processed_at: Date | null }>(
        `SELECT processed_at FROM stripe_events WHERE event_id = '${eventId}'`,
      )
    )[0]?.processed_at ?? null;

  it('adds the column and backfills legacy events when the migration was skipped', async () => {
    await testDb.exec(`ALTER TABLE "stripe_events" DROP COLUMN "processed_at"`);
    await testDb.exec(
      `INSERT INTO "stripe_events" ("event_id", "type") VALUES ('evt_legacy_711', 'payment_intent.succeeded')`,
    );

    await testDb.exec(REPAIR_SQL as string);

    expect(await processedAt('evt_legacy_711')).not.toBeNull();
  });

  it('re-running the repair leaves an unprocessed event unprocessed', async () => {
    await testDb.exec(
      `INSERT INTO "stripe_events" ("event_id", "type") VALUES ('evt_unprocessed_711', 'payment_intent.succeeded')`,
    );

    await testDb.exec(REPAIR_SQL as string);

    expect(await processedAt('evt_unprocessed_711')).toBeNull();
  });
});
