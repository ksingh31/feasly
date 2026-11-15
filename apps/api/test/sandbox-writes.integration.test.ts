/**
 * #793 — sandbox (feasly_test_) writes end to end against real migrations.
 *
 * Real estimate + lead services over the real Drizzle stores (PGlite). A
 * sandbox write must land as sandbox=true rows in `estimates`, `leads` and
 * `magic_links` (so the sandbox-purge timer finds them) and send no email;
 * a live write must land as normal rows and send the email.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import { createEstimateService } from '../src/services/estimate.service';
import { createDrizzleEstimateStore } from '../src/services/estimate.store';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createDrizzleMagicLinkStore } from '../src/services/magic-link.store';
import { createLeadService } from '../src/services/lead.service';
import { createDrizzleSandboxPurgeStore } from '../src/services/sandbox-purge.store';
import type {
  EmailDelivery,
  EmailService,
  MagicLinkEmailInput,
} from '../src/services/email/email.service';
import type { UnsubscribeService } from '../src/services/unsubscribe.service';
import { mockCommunityStatsService } from './helpers/mock-community-stats';
import { createTestDb, type TestDb } from './pglite-db';

const ESTIMATE_BODY = {
  property: {
    addressKey: 'calgary-793-sandbox-st-nw',
    assessedLandValue: 650_000,
    lotSizeSqft: 6_000,
    zoning: 'R-C1',
  },
  scope: { buildSqft: 2_200, tier: 'premium' },
};

function recordingEmail(): EmailService & { sends: MagicLinkEmailInput[] } {
  const sends: MagicLinkEmailInput[] = [];
  const ok: EmailDelivery = { sent: true, provider: 'log', messageId: 'm' };
  return {
    sends,
    sendMagicLink: async (input) => {
      sends.push(input);
      return ok;
    },
    sendInvitation: async () => ok,
    sendPartnerShare: async () => ok,
    sendCallbackConfirmation: async () => ok,
    sendNudge: async () => ok,
    sendFollowUp: async () => ok,
    sendOpsAlert: async () => ok,
    sendCommissionInvoiceReady: async () => ok,
    sendCommissionPaymentReceived: async () => ok,
    sendCommissionPaymentFailed: async () => ok,
    sendContractNeedsRecording: async () => ok,
  };
}

const fakeUnsubscribe = {
  buildUnsubscribeUrl: (leadId: string) => `https://app.test/unsubscribe/${leadId}`,
} as unknown as UnsubscribeService;

describe('#793 sandbox writes (PGlite)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  function services() {
    const estimateStore = createDrizzleEstimateStore({ db: testDb.db });
    const email = recordingEmail();
    const estimate = createEstimateService({
      costData: PLACEHOLDER_COST_DATA,
      store: estimateStore,
      allowDraftCostData: true,
      communityStats: mockCommunityStatsService(),
    });
    const leads = createLeadService({
      store: createDrizzleLeadStore({ db: testDb.db }),
      estimateStore,
      magicLinks: createDrizzleMagicLinkStore({ db: testDb.db }),
      email,
      unsubscribe: fakeUnsubscribe,
      appBaseUrl: 'https://feasly.example',
      dedupWindowDays: 90,
      magicLinkTtlSeconds: 900,
    });
    return { estimate, leads, email };
  }

  async function sandboxFlags(estimateId: string, leadId: string) {
    const [e] = await testDb.rows<{ sandbox: boolean }>(
      `select sandbox from estimates where id = '${estimateId}'`,
    );
    const [l] = await testDb.rows<{ sandbox: boolean }>(
      `select sandbox from leads where id = '${leadId}'`,
    );
    const links = await testDb.rows<{ sandbox: boolean }>(
      `select sandbox from magic_links where lead_id = '${leadId}'`,
    );
    return { estimate: e?.sandbox, lead: l?.sandbox, links: links.map((r) => r.sandbox) };
  }

  it('a sandbox key writes sandbox rows, sends no email, and the purge finds them', async () => {
    const { estimate, leads, email } = services();
    const est = await estimate.estimate(ESTIMATE_BODY, { sandbox: true });
    if (!('estimateId' in est)) throw new Error('expected an estimate response');
    const lead = await leads.submitLead(
      {
        estimateId: est.estimateId,
        email: 'agent-dev@example.com',
        name: 'Agent Dev',
        timeline: 'exploring',
        marketingConsent: false,
      },
      { sandbox: true },
    );

    expect(await sandboxFlags(est.estimateId, lead.leadId)).toEqual({
      estimate: true,
      lead: true,
      links: [true],
    });
    expect(email.sends).toHaveLength(0);

    // The sandbox-purge timer counts these rows (cutoff in the future).
    const counts = await createDrizzleSandboxPurgeStore({ db: testDb.db }).countOldSandboxRows(
      new Date(Date.now() + 60_000),
    );
    expect(counts.estimates).toBeGreaterThanOrEqual(1);
    expect(counts.leads).toBeGreaterThanOrEqual(1);
    expect(counts.magicLinks).toBeGreaterThanOrEqual(1);
  });

  it('a live key writes normal rows and sends the email', async () => {
    const { estimate, leads, email } = services();
    const est = await estimate.estimate(ESTIMATE_BODY);
    if (!('estimateId' in est)) throw new Error('expected an estimate response');
    const lead = await leads.submitLead({
      estimateId: est.estimateId,
      email: 'homeowner@example.com',
      name: 'Home Owner',
      timeline: 'exploring',
      marketingConsent: false,
    });

    expect(await sandboxFlags(est.estimateId, lead.leadId)).toEqual({
      estimate: false,
      lead: false,
      links: [false],
    });
    expect(email.sends).toHaveLength(1);
  });

  it('a sandbox lead never dedupes onto a real lead for the same email + property', async () => {
    const { estimate, leads } = services();
    const body = {
      email: 'shared@example.com',
      name: 'Shared',
      timeline: 'exploring',
      marketingConsent: false,
    };
    const liveEst = await estimate.estimate(ESTIMATE_BODY);
    if (!('estimateId' in liveEst)) throw new Error('expected an estimate response');
    const live = await leads.submitLead({ ...body, estimateId: liveEst.estimateId });

    const sbEst = await estimate.estimate(ESTIMATE_BODY, { sandbox: true });
    if (!('estimateId' in sbEst)) throw new Error('expected an estimate response');
    const sandbox = await leads.submitLead(
      { ...body, name: 'Overwritten?', estimateId: sbEst.estimateId },
      { sandbox: true },
    );

    expect(sandbox.leadId).not.toBe(live.leadId);
    const [row] = await testDb.rows<{ name: string; sandbox: boolean }>(
      `select name, sandbox from leads where id = '${live.leadId}'`,
    );
    expect(row).toEqual({ name: 'Shared', sandbox: false });
  });
});
