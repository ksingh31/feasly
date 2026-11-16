/**
 * #800 — Drizzle household-estimates store + magic-link `household` column
 * against PGlite (real migrations).
 *
 * Proves the REAL query honours the list contract: one row per property
 * (that property's newest estimate), newest first, capped at `limit`,
 * other emails and quarantined leads excluded, optional address filter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDrizzleEstimateStore } from '../src/services/estimate.store';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createDrizzleHouseholdEstimatesStore } from '../src/services/household-estimates.store';
import { createDrizzleMagicLinkStore } from '../src/services/magic-link.store';
import { createTestDb, type TestDb } from './pglite-db';

const EMAIL = 'sam@example.com';
const BASE = new Date('2026-10-01T12:00:00Z').getTime();
const DAY = 86_400_000;

describe('household estimates store (#800)', () => {
  let testDb: TestDb;
  /** leadId per property index (property 0 = newest). */
  const leadIds: string[] = [];

  async function addLead(args: {
    addressKey: string;
    at: Date;
    email?: string;
    quarantined?: boolean;
    projectType?: string;
  }): Promise<string> {
    const estimates = createDrizzleEstimateStore({ db: testDb.db });
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const estimateId = randomUUID();
    await estimates.save({
      id: estimateId,
      projectType: args.projectType ?? 'new_build',
      addressKey: args.addressKey,
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'v-test',
      createdAt: args.at,
      narrative: null,
      narrativeGeneratedAt: null,
      assumptions: null,
    });
    const id = randomUUID();
    await leads.insert({
      id,
      estimateId,
      addressKey: args.addressKey,
      email: args.email ?? EMAIL,
      name: 'Sam',
      timeline: 'exploring',
      marketingConsent: false,
      consentTs: args.at,
      source: 'web',
      ...(args.quarantined ? { quarantined: true } : {}),
    });
    return id;
  }

  beforeAll(async () => {
    testDb = await createTestDb();
    // 12 properties, property i estimated i days before BASE.
    for (let i = 0; i < 12; i += 1) {
      leadIds.push(
        await addLead({
          addressKey: `calgary-${i}-test-st-sw`,
          at: new Date(BASE - i * DAY),
          projectType: i === 1 ? 'renovation' : 'new_build',
        }),
      );
    }
    // A second, OLDER lead on property 0 (outside the dedupe window): the
    // list keeps the newest estimate for the address, once.
    await addLead({ addressKey: 'calgary-0-test-st-sw', at: new Date(BASE - 100 * DAY) });
    // Noise: another email, and a quarantined lead newer than everything.
    await addLead({ addressKey: 'calgary-99-x-st', at: new Date(BASE + DAY), email: 'other@example.com' });
    await addLead({ addressKey: 'calgary-98-x-st', at: new Date(BASE + DAY), quarantined: true });
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  it('lists the 10 newest properties, newest first, one row each', async () => {
    const store = createDrizzleHouseholdEstimatesStore({ db: testDb.db });
    const rows = await store.listByEmail({ email: EMAIL, limit: 10 });
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.addressKey)).toEqual(
      Array.from({ length: 10 }, (_, i) => `calgary-${i}-test-st-sw`),
    );
    expect(rows[0]!.leadId).toBe(leadIds[0]);
    expect(rows[0]!.createdAt.getTime()).toBe(BASE);
    expect(rows[1]!.projectType).toBe('renovation');
    expect(rows.every((r) => r.sandbox === false)).toBe(true);
  });

  it('excludes other emails and quarantined leads', async () => {
    const store = createDrizzleHouseholdEstimatesStore({ db: testDb.db });
    const rows = await store.listByEmail({ email: EMAIL, limit: 50 });
    expect(rows).toHaveLength(12);
    expect(rows.find((r) => r.addressKey === 'calgary-98-x-st')).toBeUndefined();
    expect(rows.find((r) => r.addressKey === 'calgary-99-x-st')).toBeUndefined();
  });

  it('restricts to one property when addressKey is given', async () => {
    const store = createDrizzleHouseholdEstimatesStore({ db: testDb.db });
    const rows = await store.listByEmail({
      email: EMAIL,
      limit: 10,
      addressKey: 'calgary-3-test-st-sw',
    });
    expect(rows.map((r) => r.leadId)).toEqual([leadIds[3]]);
  });

  it('returns nothing for an unknown email', async () => {
    const store = createDrizzleHouseholdEstimatesStore({ db: testDb.db });
    expect(await store.listByEmail({ email: 'nobody@example.com', limit: 10 })).toEqual([]);
  });

  it('magic_links.household persists and defaults to false', async () => {
    const links = createDrizzleMagicLinkStore({ db: testDb.db });
    const plain = await links.issue({ leadId: leadIds[0]!, ttlSeconds: 60 });
    const household = await links.issue({ leadId: leadIds[0]!, ttlSeconds: 60, household: true });
    expect((await links.findByToken(plain.token))?.household).toBe(false);
    expect((await links.findByToken(household.token))?.household).toBe(true);
  });
});
