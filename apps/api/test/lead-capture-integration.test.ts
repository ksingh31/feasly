/**
 * P0 regression test: POST /api/v1/leads 500'd on live dev (2026-09-26).
 *
 * Exercises the FULL lead-capture flow with the real Drizzle stores
 * (estimate + lead + magic-link) against PGlite with every migration
 * applied — the same SQL the deploy pipeline runs. Catches store/schema
 * drift that the interface-faked lead.service.test.ts cannot see.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createLeadService } from '../src/services/lead.service';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createDrizzleEstimateStore } from '../src/services/estimate.store';
import { createDrizzleMagicLinkStore } from '../src/services/magic-link.store';
import type { EmailService } from '../src/services/email/email.service';
import type { EmailSendResult } from '../src/services/email/email.types';
import { createTestDb, type TestDb } from './pglite-db';

const ESTIMATE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-09-26T07:00:00Z');

function fakeEmail(): EmailService & { sent: unknown[] } {
  const sent: unknown[] = [];
  const ok: EmailSendResult = { provider: 'log' };
  return {
    sent,
    sendMagicLink: async (input) => { sent.push(input); return ok; },
    sendPartnerShare: async (input) => { sent.push(input); return ok; },
    sendCallbackConfirmation: async (input) => { sent.push(input); return ok; },
    sendNudge: async (input) => { sent.push(input); return ok; },
    sendOpsAlert: async (input) => { sent.push(input); return ok; },
  };
}

describe('lead capture end-to-end (real stores, PGlite)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  async function makeService(estimateId: string) {
    const estimateStore = createDrizzleEstimateStore({ db: testDb.db });
    await estimateStore.save({
      id: estimateId,
      projectType: 'new_build',
      addressKey: 'calgary-123-fake-st-nw',
      inputs: { sqft: 2200, tier: 'standard', garage: 'none', basement: 'unfinished' },
      figures: {
        build: { low: 1, base: 2, high: 3 },
        total: { low: 4, base: 5, high: 6 },
        land: { value: 7 },
      },
      rows: [],
      costDataVersion: 'v0.1.0-unclibrated',
      createdAt: NOW,
      narrative: null,
      narrativeGeneratedAt: null,
      assumptions: null,
    });
    const email = fakeEmail();
    const service = createLeadService({
      store: createDrizzleLeadStore({ db: testDb.db }),
      estimateStore,
      magicLinks: createDrizzleMagicLinkStore({ db: testDb.db }),
      email,
      appBaseUrl: 'https://feasly.example',
      dedupWindowDays: 90,
      magicLinkTtlSeconds: 604800,
      clock: () => NOW,
    });
    return { service, email };
  }

  it('clean capture: persists lead, issues magic link, emails it', async () => {
    const { service, email } = await makeService(ESTIMATE_ID);
    const result = await service.submitLead({
      email: 'homeowner@example.com',
      name: 'Jane Homeowner',
      timeline: 'exploring',
      marketingConsent: false,
      estimateId: ESTIMATE_ID,
    });
    expect(result.leadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.magicLinkSent).toBe(true);
    expect(result.expiresInDays).toBe(7);
    expect(email.sent).toHaveLength(1);
  });

  it('quarantined (honeypot) capture: persists lead, issues token, never emails', async () => {
    const { service, email } = await makeService('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const result = await service.submitLead({
      email: 'bot@example.com',
      name: 'Bot',
      timeline: 'exploring',
      marketingConsent: false,
      estimateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      website: 'http://spam.example',
    });
    expect(result.leadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.magicLinkSent).toBe(false);
    expect(email.sent).toHaveLength(0);
  });
});
