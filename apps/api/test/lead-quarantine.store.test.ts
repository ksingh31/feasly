/**
 * HRD-03 — quarantine exclusion tests against PGlite.
 *
 * AC1: a honeypot-filled submission is written with `quarantined=true`,
 * excluded from the default admin listing (`listLeads` without
 * `includeQuarantined`), and excluded from Sheets sync candidates
 * (`findSheetsSyncCandidates`). The quarantine tab opts back in explicitly.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDrizzleEstimateStore } from '../src/services/estimate.store';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createTestDb, type TestDb } from './pglite-db';

const EMAIL = 'quarantine@example.com';
const ADDRESS_KEY = 'calgary-999-quarantine-test';
const T1 = new Date('2026-09-24T12:00:00Z');

describe('lead store quarantine exclusions (HRD-03)', () => {
  let testDb: TestDb;
  let cleanId: string;
  let spamId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    const estimates = createDrizzleEstimateStore({ db: testDb.db });
    const leads = createDrizzleLeadStore({ db: testDb.db });

    const estimateId = randomUUID();
    await estimates.save({
      id: estimateId,
      projectType: 'new_build',
      addressKey: ADDRESS_KEY,
      inputs: {},
      figures: { total: { base: 1_200_000 } },
      rows: [],
      costDataVersion: 'v0.1.0-unclibrated',
      createdAt: T1,
    });

    cleanId = randomUUID();
    await leads.insert({
      id: cleanId,
      estimateId,
      addressKey: ADDRESS_KEY,
      email: EMAIL,
      name: 'Legit',
      timeline: 'exploring',
      marketingConsent: true,
      consentTs: T1,
      source: 'api',
    });

    // Honeypot-tripped submission: quarantined=true.
    spamId = randomUUID();
    await leads.insert({
      id: spamId,
      estimateId,
      addressKey: ADDRESS_KEY,
      email: 'bot@spam.example',
      name: 'Spam Bot',
      timeline: 'exploring',
      marketingConsent: false,
      consentTs: T1,
      source: 'api',
      quarantined: true,
    });
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  it('excludes quarantined rows from the default admin listing', async () => {
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const rows = await leads.listLeads();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(cleanId);
    expect(ids).not.toContain(spamId);
  });

  it('includes quarantined rows when the quarantine tab opts in explicitly', async () => {
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const rows = await leads.listLeads({ includeQuarantined: true });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(cleanId);
    expect(ids).toContain(spamId);
  });

  it('excludes quarantined rows from Sheets sync candidates', async () => {
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const rows = await leads.findSheetsSyncCandidates({ limit: 100 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(cleanId);
    expect(ids).not.toContain(spamId);
  });
});
