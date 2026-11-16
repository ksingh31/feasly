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
import type { EmailDelivery } from '../src/services/email/email.service';
import { createTestDb, type TestDb } from './pglite-db';
import { createUnsubscribeService } from '../src/services/unsubscribe.service';
import { createDrizzleAdminLeadsStore } from '../src/services/admin-leads.store';
import { createAdminLeadsService } from '../src/services/admin-leads.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';

const ESTIMATE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-09-26T07:00:00Z');

function fakeEmail(): EmailService & { sent: unknown[] } {
  const sent: unknown[] = [];
  const ok: EmailDelivery = { sent: true, provider: 'log' };
  return {
    sent,
    sendMagicLink: async (input) => { sent.push(input); return ok; },
    sendInvitation: async (input) => { sent.push(input); return ok; },
    sendPartnerShare: async (input) => { sent.push(input); return ok; },
    sendCallbackConfirmation: async (input) => { sent.push(input); return ok; },
    sendNudge: async (input) => { sent.push(input); return ok; },
    sendFollowUp: async (input) => { sent.push(input); return ok; },
    sendOpsAlert: async (input) => { sent.push(input); return ok; },
    sendCommissionInvoiceReady: async (input) => { sent.push(input); return ok; },
    sendCommissionPaymentReceived: async (input) => { sent.push(input); return ok; },
    sendCommissionPaymentFailed: async (input) => { sent.push(input); return ok; },
    sendCommissionPaymentActionRequired: async (input) => { sent.push(input); return ok; },
    sendContractNeedsRecording: async (input) => { sent.push(input); return ok; },
    sendBuilderNewLead: async () => ok,
    sendBuilderNeedsYouDigest: async () => ok,
    sendErasureConfirmation: async () => ok,
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
    const leadStore = createDrizzleLeadStore({ db: testDb.db });
    const service = createLeadService({
      store: leadStore,
      estimateStore,
      magicLinks: createDrizzleMagicLinkStore({ db: testDb.db }),
      email,
      unsubscribe: createUnsubscribeService({
        leads: leadStore,
        unsubscribeUrlBase: 'https://feasly.example',
        tokenSecret: 'integration-test-secret',
        tokenTtlSeconds: 30 * 86_400,
      }),
      appBaseUrl: 'https://feasly.example',
      dedupWindowDays: 90,
      magicLinkTtlSeconds: 604800,
      clock: () => NOW,
    });
    return { service, email, leadStore, estimateStore };
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

  it('#814: a lead submitted with source stores and returns those values', async () => {
    const estimateId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const { service, leadStore, estimateStore } = await makeService(estimateId);
    const result = await service.submitLead({
      email: 'campaign@example.com',
      name: 'Pat Campaign',
      timeline: '3-6mo',
      marketingConsent: true,
      estimateId,
      source: {
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: 'spring-infill',
        utm_term: 'infill builder calgary',
        utm_content: 'ad-a',
        click_id_type: 'gclid',
      },
    });

    // Stored on the source_* columns.
    const rows = await testDb.rows<Record<string, unknown>>(
      `select source, source_utm_source, source_utm_medium, source_utm_campaign,
              source_utm_term, source_utm_content, source_click_id_type
         from leads where id = '${result.leadId}'`,
    );
    expect(rows[0]).toEqual({
      source: 'api',
      source_utm_source: 'google',
      source_utm_medium: 'cpc',
      source_utm_campaign: 'spring-infill',
      source_utm_term: 'infill builder calgary',
      source_utm_content: 'ad-a',
      source_click_id_type: 'gclid',
    });

    // Returned by the admin lead detail API (real admin-leads store).
    const audit: AdminAuditStore = {
      log: async () => undefined,
      append: async (args) => ({
        id: 'audit-1',
        action: args.action,
        actorEmail: args.actorEmail,
        detail: args.detail ?? null,
        createdAt: NOW,
      }),
      recent: async () => [],
    };
    const adminLeads = createAdminLeadsService({
      store: createDrizzleAdminLeadsStore({ db: testDb.db }),
      leadStore,
      estimateStore,
      audit,
      maxExportRows: 100,
    });
    const detail = await adminLeads.getLead(result.leadId, 'admin@example.com');
    expect(detail.source).toBe('api');
    expect(detail.attribution).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'spring-infill',
      utm_term: 'infill builder calgary',
      utm_content: 'ad-a',
      click_id_type: 'gclid',
    });

    // And by the lead store the Sheets sync reads.
    const record = await leadStore.findById(result.leadId);
    expect(record?.attribution?.utmCampaign).toBe('spring-infill');
  });

  it('#814: invalid source fields are dropped, never fail the capture', async () => {
    const estimateId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const { service } = await makeService(estimateId);
    const result = await service.submitLead({
      email: 'odd-tags@example.com',
      name: 'Odd Tags',
      timeline: 'exploring',
      marketingConsent: false,
      estimateId,
      source: {
        utm_source: 'google',
        utm_term: 'someone@example.com',
        utm_campaign: 'x'.repeat(101),
        click_id_type: 'not-a-click-id',
        gclid: 'raw-click-id-value',
      },
    });
    const rows = await testDb.rows<Record<string, unknown>>(
      `select source_utm_source, source_utm_term, source_utm_campaign, source_click_id_type
         from leads where id = '${result.leadId}'`,
    );
    expect(rows[0]).toEqual({
      source_utm_source: 'google',
      source_utm_term: null,
      source_utm_campaign: null,
      source_click_id_type: null,
    });
  });
});
