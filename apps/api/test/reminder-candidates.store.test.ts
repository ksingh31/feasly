/**
 * Reminder candidate SQL (#838, AC2) against PGlite with real migrations.
 *
 * - "started but didn't finish" (nudge candidates): marketing consent only.
 * - "finished but no builder contact" (follow-up candidates): consent only,
 *   and never a lead that already asked for a callback.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callbackRequests, estimates, leads } from '../src/db/schema';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createDrizzleLeadFollowUpStore } from '../src/services/lead-follow-up.store';
import { createTestDb, type TestDb } from './pglite-db';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const HOUR = 3_600_000;

describe('reminder candidate queries (#838)', () => {
  let testDb: TestDb;

  async function seedLead(over: Partial<typeof leads.$inferInsert>): Promise<string> {
    const id = randomUUID();
    const estimateId = randomUUID();
    await testDb.db.insert(estimates).values({
      id: estimateId,
      projectType: 'new_build',
      addressKey: `calgary-${id}`,
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'v0.2.0',
    });
    await testDb.db.insert(leads).values({
      id,
      estimateId,
      addressKey: `calgary-${id}`,
      email: `${id}@example.com`,
      name: 'Ava',
      timeline: '6-12 months',
      consentTs: NOW,
      ...over,
    });
    return id;
  }

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('nudge candidates exclude leads without marketing consent', async () => {
    const createdAt = new Date(NOW.getTime() - 24.5 * HOUR);
    const consenting = await seedLead({ createdAt, marketingConsent: true });
    const declined = await seedLead({ createdAt, marketingConsent: false });
    const rows = await createDrizzleLeadStore({ db: testDb.db }).findNudgeCandidates({
      createdAfter: new Date(NOW.getTime() - 25 * HOUR),
      createdBefore: new Date(NOW.getTime() - 24 * HOUR),
      limit: 100,
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(consenting);
    expect(ids).not.toContain(declined);
  });

  it('follow-up candidates exclude leads that requested a builder callback', async () => {
    const reportOpenedAt = new Date(NOW.getTime() - 72.5 * HOUR);
    const quiet = await seedLead({ reportOpenedAt, marketingConsent: true });
    const called = await seedLead({ reportOpenedAt, marketingConsent: true });
    await testDb.db.insert(callbackRequests).values({
      id: randomUUID(),
      leadId: called,
      name: 'Ava',
      phone: '403-555-0100',
      window: 'morning',
    });
    const store = createDrizzleLeadFollowUpStore({ db: testDb.db });
    const ids = await store.findCandidates({
      openedAfter: new Date(NOW.getTime() - 73 * HOUR),
      openedBefore: new Date(NOW.getTime() - 72 * HOUR),
      limit: 100,
    });
    expect(ids).toContain(quiet);
    expect(ids).not.toContain(called);
    expect(await store.hasCallbackRequest(called)).toBe(true);
    expect(await store.hasCallbackRequest(quiet)).toBe(false);
  });
});
