/**
 * consumer/02 — Drizzle lead-store dedupe tests against PGlite.
 *
 * The service-level field matrix is covered with fakes in
 * lead.service.test.ts; these tests prove the REAL store honors it:
 * `updateOnRepeat` rewrites only its five columns, notes + status history
 * survive the update untouched, and `findNewestEstimateIdByEmailAndAddress`
 * resolves across leads (old magic links → newest snapshot).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDrizzleEstimateStore } from '../src/services/estimate.store';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createTestDb, type TestDb } from './pglite-db';

const EMAIL = 'sam@example.com';
const ADDRESS_KEY = 'calgary-123-fake-st-nw';
const T1 = new Date('2026-09-20T12:00:00Z');
const T2 = new Date('2026-09-24T12:00:00Z');

describe('lead store dedupe (consumer/02)', () => {
  let testDb: TestDb;
  let leadId: string;
  let oldEstimateId: string;
  let newEstimateId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    const estimates = createDrizzleEstimateStore({ db: testDb.db });
    const leads = createDrizzleLeadStore({ db: testDb.db });

    oldEstimateId = randomUUID();
    newEstimateId = randomUUID();
    for (const [id, createdAt] of [
      [oldEstimateId, T1],
      [newEstimateId, T2],
    ] as const) {
      await estimates.save({
        id,
        projectType: 'new_build',
        addressKey: ADDRESS_KEY,
        inputs: {},
        figures: { total: { base: 1_200_000 } },
        rows: [],
        costDataVersion: 'v0.1.0-unclibrated',
        createdAt,
      });
    }

    leadId = randomUUID();
    await leads.insert({
      id: leadId,
      estimateId: oldEstimateId,
      addressKey: ADDRESS_KEY,
      email: EMAIL,
      name: 'Sam',
      timeline: 'exploring',
      marketingConsent: true,
      consentTs: T1,
      source: 'api',
    });
    await leads.appendNote({
      id: randomUUID(),
      leadId,
      note: 'Called — asked about infill timeline.',
    });
    await leads.appendStatusHistory({
      id: randomUUID(),
      leadId,
      oldStatus: 'new',
      newStatus: 'contacted',
      changedBy: 'admin@example.com',
    });
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  it('defaults lead_score to 0 and status to new on insert', async () => {
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const row = await leads.findById(leadId);
    expect(row?.leadScore).toBe(0);
    expect(row?.status).toBe('new');
  });

  it('updateOnRepeat rewrites only its five columns', async () => {
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const updated = await leads.updateOnRepeat({
      id: leadId,
      name: 'Samuel',
      phone: '+1 403-555-0100',
      timeline: '0-3mo',
      leadScore: 50,
      estimateId: newEstimateId,
    });
    // Updated:
    expect(updated.name).toBe('Samuel');
    expect(updated.phone).toBe('+1 403-555-0100');
    expect(updated.timeline).toBe('0-3mo');
    expect(updated.leadScore).toBe(50);
    expect(updated.estimateId).toBe(newEstimateId);
    // Never clobbered:
    expect(updated.email).toBe(EMAIL);
    expect(updated.addressKey).toBe(ADDRESS_KEY);
    expect(updated.marketingConsent).toBe(true);
    expect(updated.consentTs).toEqual(T1);
    expect(updated.status).toBe('new');
    expect(updated.quarantined).toBe(false);
    expect(updated.createdAt).toBeInstanceOf(Date);
  });

  it('preserves notes and status history across the dedupe update', async () => {
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const notes = await leads.getNotes(leadId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note).toBe('Called — asked about infill timeline.');
    const history = await leads.getStatusHistory(leadId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      oldStatus: 'new',
      newStatus: 'contacted',
      changedBy: 'admin@example.com',
    });
  });

  it('resolves the newest estimate across leads for an email + address', async () => {
    const leads = createDrizzleLeadStore({ db: testDb.db });
    // A second, older lead pointing at the OLD estimate must not win.
    await leads.insert({
      id: randomUUID(),
      estimateId: oldEstimateId,
      addressKey: ADDRESS_KEY,
      email: EMAIL,
      name: 'Sam (old)',
      timeline: 'exploring',
      marketingConsent: false,
      consentTs: T1,
      source: 'api',
    });
    const newest = await leads.findNewestEstimateIdByEmailAndAddress({
      email: EMAIL,
      addressKey: ADDRESS_KEY,
    });
    expect(newest?.estimateId).toBe(newEstimateId);
  });

  it('returns null for an unknown email + address', async () => {
    const leads = createDrizzleLeadStore({ db: testDb.db });
    expect(
      await leads.findNewestEstimateIdByEmailAndAddress({
        email: 'nobody@example.com',
        addressKey: ADDRESS_KEY,
      }),
    ).toBeNull();
  });
});
