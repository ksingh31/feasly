/**
 * consumer/02 — magic-link service tests.
 *
 * Covers `verify` (old tokens resolve to the NEWEST estimate — AC2) and
 * `reissue` (idempotent: live link → no resend, expired/missing → reissue
 * + email, unknown email → no oracle). Stores are faked at the interface
 * boundary; the real Drizzle stores are covered against PGlite in
 * lead-dedupe.store.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  createMagicLinkService,
  isMagicLinkLive,
} from '../src/services/magic-link.service';
import type {
  IssuedMagicLink,
  MagicLinkRecord,
  MagicLinkStore,
} from '../src/services/magic-link.store';
import type {
  LeadRecord,
  LeadStore,
} from '../src/services/lead.store';
import type {
  HouseholdEstimateRow,
  HouseholdEstimatesStore,
} from '../src/services/household-estimates.store';
import type { IssueMagicLinkArgs } from '../src/services/magic-link.store';
import type {
  EmailService,
  MagicLinkEmailInput,
} from '../src/services/email/email.service';
import type { EmailDelivery } from '../src/services/email/email.service';
import type { UnsubscribeService } from '../src/services/unsubscribe.service';
import { HttpError } from '../src/middleware/errors';
import { createRateLimiter } from '../src/middleware/rate-limit';
import {
  createSharedCooldown,
  createSharedRateLimiter,
} from '../src/middleware/shared-rate-limit';
import { createFakeSharedCounterStore } from './fake-shared-counter-store';

const NOW = new Date('2026-09-24T12:00:00Z');
const LEAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OLD_ESTIMATE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEW_ESTIMATE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APP_BASE_URL = 'https://feasly.example';

function linkRecord(overrides?: Partial<MagicLinkRecord>): MagicLinkRecord {
  return {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    leadId: LEAD_ID,
    purpose: 'lead',
    email: null,
    tokenHash: 'hash',
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    usedAt: null,
    revokedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function leadFixture(overrides?: Partial<LeadRecord>): LeadRecord {
  return {
    id: LEAD_ID,
    estimateId: OLD_ESTIMATE_ID,
    addressKey: 'calgary-123-fake-st-nw',
    email: 'sam@example.com',
    name: 'Sam',
    phone: null,
    timeline: 'exploring',
    marketingConsent: false,
    consentTs: NOW,
    tenantKey: null,
    source: 'api',
    quarantined: false,
    sandbox: false,
    leadScore: 0,
    status: 'new',
    builderId: null,
    unsubscribedAt: null,
    contactOptOutAt: null,
    consentUpdatedAt: NOW,
    nudgeSentAt: null,
    sheetsSyncedAt: null,
    updatedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

interface FakeMagicLinks extends MagicLinkStore {
  issued: number;
  issuedArgs: IssueMagicLinkArgs[];
  byToken: Map<string, MagicLinkRecord>;
  byLead: Map<string, MagicLinkRecord[]>;
}

function fakeMagicLinks(): FakeMagicLinks {
  const byToken = new Map<string, MagicLinkRecord>();
  const byLead = new Map<string, MagicLinkRecord[]>();
  let issued = 0;
  const issuedArgs: IssueMagicLinkArgs[] = [];
  return {
    get issued() {
      return issued;
    },
    issuedArgs,
    byToken,
    byLead,
    issue: async (args): Promise<IssuedMagicLink> => {
      issued += 1;
      issuedArgs.push(args);
      return {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        token: `<redacted>`,
        expiresAt: new Date(NOW.getTime() + args.ttlSeconds * 1000),
      };
    },
    findByToken: async (token: string) => byToken.get(token) ?? null,
    findByLeadIds: async (leadIds: readonly string[]) =>
      leadIds.flatMap((id) => byLead.get(id) ?? []),
    revokeByLeadIds: async () => 0,
    markUsed: async () => true,
  };
}

function fakeLeads(opts?: {
  lead?: LeadRecord | null;
  household?: LeadRecord[];
  newestEstimateId?: string | null;
}): LeadStore {
  const lead = opts?.lead === undefined ? leadFixture() : opts.lead;
  const household = opts?.household ?? (lead ? [lead] : []);
  const newestEstimateId =
    opts?.newestEstimateId === undefined ? NEW_ESTIMATE_ID : opts.newestEstimateId;
  const noop = async () => {};
  return {
    findRecentByEmailAndAddress: async () => null,
    insert: async () => {
      throw new Error('not implemented');
    },
    updateOnRepeat: async () => {
      throw new Error('not implemented');
    },
    findNewestEstimateIdByEmailAndAddress: async () =>
      newestEstimateId
        ? { estimateId: newestEstimateId, createdAt: NOW }
        : null,
    listLeads: async () => [],
    findById: async (id: string) =>
      (lead && lead.id === id ? lead : household.find((l) => l.id === id)) ?? null,
    findByIdAndBuilderId: async () => null,
    existsById: async () => false,
    findByEstimateId: async () => null,
    setUnsubscribedAt: async () => lead,
    findNudgeCandidates: async () => [],
    setNudgeSentAt: async () => null,
    findAllByEmail: async () => household,
    deleteByEmail: async () => 0,
    findSheetsSyncCandidates: async () => [],
    setSheetsSyncedAt: async () => null,
    countNeverSynced: async () => 0,
      listByTenantKey: async () => [],
      listByBuilderId: async () => [],
      updateStatus: async () => null,
      updateStatusForBuilder: async () => null,
      updateConsentPreferences: async () => null,
    appendNote: noop,
    getNotes: async () => [],
    appendStatusHistory: noop,
    getStatusHistory: async () => [],
  };
}

function fakeEmail(): EmailService & { sends: MagicLinkEmailInput[] } {
  const sends: MagicLinkEmailInput[] = [];
  const ok: EmailDelivery = { sent: true, provider: 'log' };
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
    sendCommissionPaymentActionRequired: async () => ok,
    sendContractNeedsRecording: async () => ok,
    sendBuilderNewLead: async () => ok,
    sendBuilderNeedsYouDigest: async () => ok,
    sendErasureConfirmation: async () => ok,
  };
}

/**
 * Fake unsubscribe service: mints deterministic preference-page URLs so the
 * magic-link email footer can be asserted without HMAC secrets.
 */
const fakeUnsubscribe = {
  buildUnsubscribeUrl: (leadId: string) =>
    `https://app.test/unsubscribe/tok-${leadId}`,
} as unknown as UnsubscribeService;

/**
 * #800: fake household list. Rows are given newest-first per property; the
 * fake applies the store's email/addressKey/limit contract.
 */
interface FakeHousehold extends HouseholdEstimatesStore {
  calls: Array<{ email: string; limit: number; addressKey?: string }>;
}

function fakeHousehold(rows: Array<HouseholdEstimateRow & { email?: string }> = []): FakeHousehold {
  const calls: FakeHousehold['calls'] = [];
  return {
    calls,
    listByEmail: async (args) => {
      calls.push({ ...args });
      return rows
        .filter((r) => (r.email ?? 'sam@example.com') === args.email)
        .filter((r) => args.addressKey === undefined || r.addressKey === args.addressKey)
        .slice(0, args.limit)
        .map(({ email: _email, ...row }) => row);
    },
  };
}

function makeService(opts?: {
  magicLinks?: FakeMagicLinks;
  leads?: LeadStore;
  household?: FakeHousehold;
  householdListLimit?: number;
  householdListEmailEnabled?: boolean;
  email?: EmailService & { sends: MagicLinkEmailInput[] };
  ttlSeconds?: number;
  reissueCooldownMs?: number;
  maxSendsPerHour?: number;
  clock?: () => Date;
}) {
  const magicLinks = opts?.magicLinks ?? fakeMagicLinks();
  const leads = opts?.leads ?? fakeLeads();
  const email = opts?.email ?? fakeEmail();
  const household = opts?.household ?? fakeHousehold();
  const service = createMagicLinkService({
    magicLinks,
    leads,
    householdEstimates: household,
    householdListLimit: opts?.householdListLimit ?? 10,
    householdListEmailEnabled: opts?.householdListEmailEnabled ?? true,
    email,
    unsubscribe: fakeUnsubscribe,
    appBaseUrl: APP_BASE_URL,
    magicLinkTtlSeconds: opts?.ttlSeconds ?? 7 * 86_400,
    magicLinkReissueCooldownMs: opts?.reissueCooldownMs ?? 60_000,
    magicLinkMaxSendsPerHour: opts?.maxSendsPerHour ?? 5,
    clock: opts?.clock ?? (() => NOW),
  });
  return { service, magicLinks, leads, email, household };
}

describe('magic-link verify', () => {
  it('rejects a partner-share token — a different token type verifies on /v1/shares/verify', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set(
      'partner-token',
      linkRecord({ purpose: 'partner-share' }),
    );
    const { service } = makeService({ magicLinks });
    // Live, well-formed, lead-backed — still invalid here: purpose gates it.
    expect(await service.verify('partner-token')).toEqual({
      valid: false,
      reason: 'invalid',
      reissueAllowed: true,
    });
  });

  it('resolves a live token to the NEWEST estimate, not the token-era one (AC2)', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('old-token', linkRecord());
    const { service } = makeService({ magicLinks });
    const result = await service.verify('old-token');
    expect(result).toEqual({
      valid: true,
      reportToken: 'old-token',
      estimateId: NEW_ESTIMATE_ID,
      leadId: LEAD_ID,
    });
  });

  it('#703 AC2: the same owner link verifies again on a second open (reusable until expiry)', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('email-token', linkRecord());
    const { service } = makeService({ magicLinks });
    const first = await service.verify('email-token');
    const second = await service.verify('email-token');
    expect(first).toMatchObject({ valid: true, reportToken: 'email-token' });
    expect(second).toEqual(first);
  });

  it('falls back to the link-era estimate when the household has none left', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('old-token', linkRecord());
    const { service } = makeService({
      magicLinks,
      leads: fakeLeads({ newestEstimateId: null }),
    });
    const result = await service.verify('old-token');
    expect(result).toEqual({
      valid: true,
      reportToken: 'old-token',
      estimateId: OLD_ESTIMATE_ID,
      leadId: LEAD_ID,
    });
  });

  it('rejects an unknown token without an oracle', async () => {
    const { service } = makeService();
    expect(await service.verify('nope')).toEqual({
      valid: false,
      reason: 'invalid',
      reissueAllowed: true,
    });
  });

  it('rejects a token whose lead was erased', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('orphan', linkRecord());
    const { service } = makeService({
      magicLinks,
      leads: fakeLeads({ lead: null, household: [] }),
    });
    expect(await service.verify('orphan')).toEqual({
      valid: false,
      reason: 'invalid',
      reissueAllowed: true,
    });
  });

  it('reports expired for a past-due token and allows reissue', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set(
      'stale',
      linkRecord({ expiresAt: new Date(NOW.getTime() - 1000) }),
    );
    const { service } = makeService({ magicLinks });
    expect(await service.verify('stale')).toEqual({
      valid: false,
      reason: 'expired',
      reissueAllowed: true,
    });
  });

  it('reports expired for a revoked token', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('revoked', linkRecord({ revokedAt: NOW }));
    const { service } = makeService({ magicLinks });
    expect(await service.verify('revoked')).toEqual({
      valid: false,
      reason: 'expired',
      reissueAllowed: true,
    });
  });

  it('disallows reissue for quarantined leads', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set(
      'stale',
      linkRecord({ expiresAt: new Date(NOW.getTime() - 1000) }),
    );
    const { service } = makeService({
      magicLinks,
      leads: fakeLeads({ lead: leadFixture({ quarantined: true }) }),
    });
    expect(await service.verify('stale')).toEqual({
      valid: false,
      reason: 'expired',
      reissueAllowed: false,
    });
  });
});

describe('magic-link reissue', () => {
  it('sends nothing when a live household link exists (AC4)', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byLead.set(LEAD_ID, [linkRecord({ household: true })]);
    const email = fakeEmail();
    const { service } = makeService({ magicLinks, email });
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: false,
    });
    expect(magicLinks.issued).toBe(0);
    expect(email.sends).toHaveLength(0);
  });

  it('reissues and emails when the only link expired', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byLead.set(LEAD_ID, [
      linkRecord({ expiresAt: new Date(NOW.getTime() - 1000) }),
    ]);
    const email = fakeEmail();
    const { service } = makeService({ magicLinks, email });
    expect(await service.reissue({ email: 'SAM@example.com' })).toEqual({
      sent: true,
    });
    expect(magicLinks.issued).toBe(1);
    expect(email.sends).toHaveLength(1);
    expect(email.sends[0]!.to).toBe('sam@example.com');
    expect(email.sends[0]!.magicLinkUrl.startsWith(APP_BASE_URL)).toBe(true);
    expect(email.sends[0]!.expiresInDays).toBe(7);
    // #703: the report email names the property and states the real expiry.
    expect(email.sends[0]!.address).toBe('Calgary 123 Fake St NW');
    expect(email.sends[0]!.expiresOn).toEqual(
      new Date(NOW.getTime() + 7 * 86_400 * 1000),
    );
  });

  it('reissues when the lead never had a link', async () => {
    const email = fakeEmail();
    const { service } = makeService({ email });
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: true,
    });
    expect(email.sends).toHaveLength(1);
  });

  it('answers sent:false for unknown emails without revealing it', async () => {
    const magicLinks = fakeMagicLinks();
    const email = fakeEmail();
    const { service } = makeService({
      magicLinks,
      email,
      leads: fakeLeads({ lead: null, household: [] }),
    });
    expect(await service.reissue({ email: 'nobody@example.com' })).toEqual({
      sent: false,
    });
    expect(magicLinks.issued).toBe(0);
    expect(email.sends).toHaveLength(0);
  });

  it('sends nothing for quarantined leads', async () => {
    const magicLinks = fakeMagicLinks();
    const email = fakeEmail();
    const { service } = makeService({
      magicLinks,
      email,
      leads: fakeLeads({ lead: leadFixture({ quarantined: true }) }),
    });
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: false,
    });
    expect(email.sends).toHaveLength(0);
  });

  it('email/03 AC4: an opted-out lead still gets their transactional magic link', async () => {
    const magicLinks = fakeMagicLinks();
    const email = fakeEmail();
    const { service } = makeService({
      magicLinks,
      email,
      leads: fakeLeads({
        lead: leadFixture({ unsubscribedAt: new Date('2026-09-20T00:00:00Z') }),
      }),
    });
    // The opt-out suppresses nudges/marketing (email/02's timer checks
    // isUnsubscribed) — never the requested magic link itself.
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: true,
    });
    expect(email.sends).toHaveLength(1);
  });

  it('rejects a malformed email with 400', async () => {
    const { service } = makeService();
    const error = await service.reissue({ email: 'not-an-email' }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
  });

  it('HRD-03: blocks a resend within the per-email cooldown', async () => {
    const email = fakeEmail();
    let nowMs = NOW.getTime();
    const { service } = makeService({
      email,
      reissueCooldownMs: 60_000,
      clock: () => new Date(nowMs),
    });
    // No links in the store → first reissue sends.
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: true,
    });
    expect(email.sends).toHaveLength(1);
    // 30s later the store still has no live link (the fake never persists
    // issued links), but the cooldown blocks the resend — same shape, no
    // send oracle.
    nowMs += 30_000;
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: false,
    });
    expect(email.sends).toHaveLength(1);
  });

  it('HRD-03: allows a resend after the per-email cooldown elapses', async () => {
    const email = fakeEmail();
    let nowMs = NOW.getTime();
    const { service } = makeService({
      email,
      reissueCooldownMs: 60_000,
      clock: () => new Date(nowMs),
    });
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: true,
    });
    nowMs += 61_000;
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: true,
    });
    expect(email.sends).toHaveLength(2);
  });

  it('HRD-03: cooldown is per-email — a different address is unaffected', async () => {
    const email = fakeEmail();
    const samLead = leadFixture();
    const otherLead = leadFixture({
      id: 'other-lead-id',
      email: 'other@example.com',
    });
    const baseLeads = fakeLeads();
    const leads: LeadStore = {
      ...baseLeads,
      findAllByEmail: async (addr: string) =>
        [samLead, otherLead].filter((l) => l.email === addr),
    };
    const nowMs = NOW.getTime();
    const { service } = makeService({
      email,
      leads,
      reissueCooldownMs: 60_000,
      clock: () => new Date(nowMs),
    });
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: true,
    });
    // Same instant, different address → no cooldown entry → sends.
    expect(await service.reissue({ email: 'other@example.com' })).toEqual({
      sent: true,
    });
    expect(email.sends).toHaveLength(2);
  });

  it('#729: a cooldown started on one instance blocks a resend on another', async () => {
    const store = createFakeSharedCounterStore();
    const email = fakeEmail();
    let nowMs = NOW.getTime();
    const clockMs = () => nowMs;
    const build = () =>
      createMagicLinkService({
        magicLinks: fakeMagicLinks(),
        leads: fakeLeads(),
        householdEstimates: fakeHousehold(),
        householdListLimit: 10,
        email,
        unsubscribe: fakeUnsubscribe,
        appBaseUrl: APP_BASE_URL,
        magicLinkTtlSeconds: 7 * 86_400,
        magicLinkReissueCooldownMs: 60_000,
        magicLinkMaxSendsPerHour: 2,
        reissueCooldown: createSharedCooldown({
          store,
          scope: 'magic-link:cooldown',
          cooldownMs: 60_000,
          clock: clockMs,
        }),
        sendBudget: createSharedRateLimiter({
          store,
          scope: 'magic-link:send',
          windowMs: 3_600_000,
          maxRequests: 2,
          sweepIntervalMs: 300_000,
          fallback: createRateLimiter({
            windowMs: 3_600_000,
            maxRequests: 2,
            maxTrackedKeys: 100,
            clock: clockMs,
          }),
          clock: clockMs,
        }),
        clock: () => new Date(nowMs),
      });
    const instanceA = build();
    const instanceB = build();
    expect(await instanceA.reissue({ email: 'sam@example.com' })).toEqual({ sent: true });
    nowMs += 1_000;
    // Different instance, inside the cooldown: blocked (would send pre-#729).
    expect(await instanceB.reissue({ email: 'sam@example.com' })).toEqual({ sent: false });
    nowMs += 61_000;
    expect(await instanceB.reissue({ email: 'sam@example.com' })).toEqual({ sent: true });
    nowMs += 61_000;
    // Shared hourly budget of 2 is spent across both instances.
    expect(await instanceA.reissue({ email: 'sam@example.com' })).toEqual({ sent: false });
    expect(email.sends).toHaveLength(2);
  });

  it('P1-6: blocks the 6th send within the hourly per-email budget', async () => {
    const email = fakeEmail();
    let nowMs = NOW.getTime();
    const { service } = makeService({
      email,
      reissueCooldownMs: 60_000,
      maxSendsPerHour: 5,
      clock: () => new Date(nowMs),
    });
    // Five sends, each past the 60s cooldown but inside the same hour.
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
        sent: true,
      });
      nowMs += 61_000;
    }
    expect(email.sends).toHaveLength(5);
    // 6th attempt: budget exhausted — same { sent: false } shape as every
    // other non-send outcome, no send oracle.
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: false,
    });
    expect(email.sends).toHaveLength(5);
  });

  it('P1-6: the hourly budget resets after the window and is per-email', async () => {
    const email = fakeEmail();
    const otherLead = leadFixture({
      id: 'other-lead-id',
      email: 'other@example.com',
    });
    const baseLeads = fakeLeads();
    const leads: LeadStore = {
      ...baseLeads,
      findAllByEmail: async (addr: string) =>
        addr === 'other@example.com' ? [otherLead] : baseLeads.findAllByEmail(addr),
    };
    let nowMs = NOW.getTime();
    const { service } = makeService({
      email,
      leads,
      reissueCooldownMs: 60_000,
      maxSendsPerHour: 1,
      clock: () => new Date(nowMs),
    });
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: true,
    });
    nowMs += 61_000;
    // Budget exhausted for sam…
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: false,
    });
    // …but a different address is unaffected.
    expect(await service.reissue({ email: 'other@example.com' })).toEqual({
      sent: true,
    });
    expect(email.sends).toHaveLength(2);
    // …and sam's budget resets once the hour window passes.
    nowMs += 3_600_000;
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({
      sent: true,
    });
    expect(email.sends).toHaveLength(3);
  });
});

describe('isMagicLinkLive', () => {
  it('treats a fresh, unrevoked link as live', () => {
    expect(isMagicLinkLive(linkRecord(), NOW)).toBe(true);
  });

  it('treats expired and revoked links as not live', () => {
    expect(
      isMagicLinkLive(
        linkRecord({ expiresAt: new Date(NOW.getTime() - 1) }),
        NOW,
      ),
    ).toBe(false);
    expect(isMagicLinkLive(linkRecord({ revokedAt: NOW }), NOW)).toBe(false);
  });
});

// ── #800: household estimate list ─────────────────────────────────────

const ADDR_A = 'calgary-123-fake-st-nw';

function leadId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** n properties, newest first; property 1 is the token lead's (ADDR_A). */
function householdRows(n: number): HouseholdEstimateRow[] {
  return Array.from({ length: n }, (_, i) => ({
    leadId: i === 0 ? LEAD_ID : leadId(i + 1),
    addressKey: i === 0 ? ADDR_A : `calgary-${i + 1}-other-st-sw`,
    estimateId: `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`,
    projectType: i % 2 === 0 ? 'new_build' : 'renovation',
    createdAt: new Date(NOW.getTime() - i * 86_400_000),
    sandbox: false,
  }));
}

function householdLeads(n: number): LeadRecord[] {
  return householdRows(n).map((r) =>
    leadFixture({ id: r.leadId, addressKey: r.addressKey, estimateId: r.estimateId }),
  );
}

describe('#800 magic-link reissue — household link', () => {
  it('mints a HOUSEHOLD link and uses "recent estimates" copy when several properties list', async () => {
    const magicLinks = fakeMagicLinks();
    const email = fakeEmail();
    const household = fakeHousehold(householdRows(3));
    const { service } = makeService({ magicLinks, email, household });
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({ sent: true });
    expect(magicLinks.issuedArgs).toHaveLength(1);
    expect(magicLinks.issuedArgs[0]).toMatchObject({ household: true, purpose: 'lead' });
    expect(email.sends[0]!.estimateCount).toBe(3);
    expect(household.calls[0]).toEqual({ email: 'sam@example.com', limit: 10 });
  });

  it('keeps the single-report email copy while the list-email flag is off (web list not shipped)', async () => {
    const magicLinks = fakeMagicLinks();
    const email = fakeEmail();
    const household = fakeHousehold(householdRows(3));
    const { service } = makeService({
      magicLinks,
      email,
      household,
      householdListEmailEnabled: false,
    });
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({ sent: true });
    // Still a household link (the list API ships dark), but no count → old copy.
    expect(magicLinks.issuedArgs[0]).toMatchObject({ household: true, purpose: 'lead' });
    expect(email.sends[0]!.estimateCount).toBeUndefined();
    expect(household.calls).toHaveLength(0);
  });

  it('keeps the single-report email when the household has one property', async () => {
    const email = fakeEmail();
    const { service } = makeService({ email, household: fakeHousehold(householdRows(1)) });
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({ sent: true });
    expect(email.sends[0]!.estimateCount).toBeUndefined();
    expect(email.sends[0]!.address).toBe('Calgary 123 Fake St NW');
  });

  it('a live PLAIN owner link (the report email / lead-submit token) does not block the household link', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byLead.set(LEAD_ID, [linkRecord()]);
    const email = fakeEmail();
    const { service } = makeService({ magicLinks, email });
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({ sent: true });
    expect(magicLinks.issuedArgs[0]).toMatchObject({ household: true });
  });

  it('still sends nothing for quarantined leads', async () => {
    const lead = leadFixture({ quarantined: true });
    const email = fakeEmail();
    const { service } = makeService({
      leads: fakeLeads({ lead }),
      email,
      household: fakeHousehold(householdRows(3)),
    });
    expect(await service.reissue({ email: 'sam@example.com' })).toEqual({ sent: false });
    expect(email.sends).toHaveLength(0);
  });
});

describe('#800 magic-link listEstimates', () => {
  it('AC1: a household link with 12 properties lists the 10 newest, newest first', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('household-token', linkRecord({ household: true }));
    const { service, household } = makeService({
      magicLinks,
      leads: fakeLeads({ household: householdLeads(12) }),
      household: fakeHousehold(householdRows(12)),
    });
    const result = await service.listEstimates('household-token');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.estimates).toHaveLength(10);
    expect(household.calls[0]).toEqual({ email: 'sam@example.com', limit: 10 });
    const times = result.estimates.map((e) => Date.parse(e.preparedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(result.estimates.map((e) => e.latest)).toEqual([true, ...Array(9).fill(false)]);
    expect(result.estimates[0]).toEqual({
      handle: LEAD_ID,
      address: 'Calgary 123 Fake St NW',
      preparedAt: NOW.toISOString(),
      projectType: 'new_build',
      latest: true,
      current: true,
    });
    expect(result.estimates[1]).toMatchObject({
      handle: leadId(2),
      projectType: 'renovation',
      current: false,
    });
    // Handles are unique — each opens its own report.
    expect(new Set(result.estimates.map((e) => e.handle)).size).toBe(10);
  });

  it('honours the configured list limit', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('household-token', linkRecord({ household: true }));
    const { service } = makeService({
      magicLinks,
      household: fakeHousehold(householdRows(12)),
      householdListLimit: 3,
    });
    const result = await service.listEstimates('household-token');
    expect(result.valid && result.estimates).toHaveLength(3);
  });

  it('AC2: an email with one estimate lists exactly that one (the UI opens it directly)', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('household-token', linkRecord({ household: true }));
    const { service } = makeService({ magicLinks, household: fakeHousehold(householdRows(1)) });
    const result = await service.listEstimates('household-token');
    expect(result).toMatchObject({ valid: true, estimates: [{ handle: LEAD_ID, current: true }] });
    expect(result.valid && result.estimates).toHaveLength(1);
  });

  it('a non-household owner token (lead-submit response) lists ONLY its own property — no address leak', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('submit-token', linkRecord());
    const { service, household } = makeService({
      magicLinks,
      household: fakeHousehold(householdRows(5)),
    });
    const result = await service.listEstimates('submit-token');
    expect(household.calls[0]).toEqual({
      email: 'sam@example.com',
      limit: 10,
      addressKey: ADDR_A,
    });
    expect(result.valid && result.estimates.map((e) => e.handle)).toEqual([LEAD_ID]);
  });

  it('a household token on a quarantined lead lists nothing beyond its own property', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('household-token', linkRecord({ household: true }));
    const { service, household } = makeService({
      magicLinks,
      leads: fakeLeads({ lead: leadFixture({ quarantined: true }) }),
      household: fakeHousehold(householdRows(5)),
    });
    await service.listEstimates('household-token');
    expect(household.calls[0]!.addressKey).toBe(ADDR_A);
  });

  it('AC3: partner-share tokens list nothing', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('partner', linkRecord({ purpose: 'partner-share', household: true }));
    const { service, household } = makeService({ magicLinks, household: fakeHousehold(householdRows(3)) });
    expect(await service.listEstimates('partner')).toEqual({
      valid: false,
      reason: 'invalid',
      reissueAllowed: true,
    });
    expect(household.calls).toHaveLength(0);
  });

  it('AC3: expired and revoked household links list nothing', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set(
      'expired',
      linkRecord({ household: true, expiresAt: new Date(NOW.getTime() - 1) }),
    );
    magicLinks.byToken.set('revoked', linkRecord({ household: true, revokedAt: NOW }));
    const { service, household } = makeService({ magicLinks, household: fakeHousehold(householdRows(3)) });
    expect(await service.listEstimates('expired')).toEqual({
      valid: false,
      reason: 'expired',
      reissueAllowed: true,
    });
    expect((await service.listEstimates('revoked')).valid).toBe(false);
    expect(household.calls).toHaveLength(0);
  });

  it('AC3: an erased lead (row gone) and unknown tokens list nothing', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('erased', linkRecord({ household: true }));
    const { service, household } = makeService({
      magicLinks,
      leads: fakeLeads({ lead: null }),
      household: fakeHousehold(householdRows(3)),
    });
    const invalid = { valid: false, reason: 'invalid', reissueAllowed: true };
    expect(await service.listEstimates('erased')).toEqual(invalid);
    expect(await service.listEstimates('unknown')).toEqual(invalid);
    expect(household.calls).toHaveLength(0);
  });
});

describe('#800 magic-link openEstimate', () => {
  function setup(opts?: { record?: Partial<MagicLinkRecord>; leads?: LeadRecord[] }) {
    const magicLinks = fakeMagicLinks();
    magicLinks.byToken.set('household-token', linkRecord({ household: true, ...opts?.record }));
    const made = makeService({
      magicLinks,
      leads: fakeLeads({ household: opts?.leads ?? householdLeads(3) }),
    });
    return { ...made, magicLinks };
  }

  it('AC1: mints an owner (non-household) report token for another listed property', async () => {
    const { service, magicLinks } = setup();
    const result = await service.openEstimate({ token: 'household-token', handle: leadId(2) });
    expect(result).toEqual({ valid: true, reportToken: '<redacted>' });
    expect(magicLinks.issuedArgs).toHaveLength(1);
    expect(magicLinks.issuedArgs[0]).toMatchObject({ leadId: leadId(2), purpose: 'lead' });
    expect(magicLinks.issuedArgs[0]!.household).toBeUndefined();
  });

  it('never extends access: the minted link expires with the household link', async () => {
    const { service, magicLinks } = setup({
      record: { expiresAt: new Date(NOW.getTime() + 3_600_000) },
    });
    await service.openEstimate({ token: 'household-token', handle: leadId(2) });
    expect(magicLinks.issuedArgs[0]!.ttlSeconds).toBe(3_600);
  });

  it('mints a plain token even for the property the household token covers (no list loop, household token never in a report URL)', async () => {
    const { service, magicLinks } = setup();
    const result = await service.openEstimate({ token: 'household-token', handle: LEAD_ID });
    expect(result).toEqual({ valid: true, reportToken: '<redacted>' });
    expect(result).not.toMatchObject({ reportToken: 'household-token' });
    expect(magicLinks.issuedArgs).toHaveLength(1);
    expect(magicLinks.issuedArgs[0]).toMatchObject({ leadId: LEAD_ID, purpose: 'lead' });
    expect(magicLinks.issuedArgs[0]!.household).toBeUndefined();
  });

  it('rejects a non-household owner token (lead-submit tokens cannot open other leads)', async () => {
    const { service, magicLinks } = setup({ record: { household: false } });
    expect(
      await service.openEstimate({ token: 'household-token', handle: leadId(2) }),
    ).toEqual({ valid: false, reason: 'invalid', reissueAllowed: true });
    expect(magicLinks.issued).toBe(0);
  });

  it("rejects another email's lead, a quarantined lead and an unknown handle with the same denial", async () => {
    const leads = [
      ...householdLeads(1),
      leadFixture({ id: leadId(7), email: 'someone@else.com', addressKey: 'x' }),
      leadFixture({ id: leadId(8), quarantined: true, addressKey: 'y' }),
    ];
    const { service, magicLinks } = setup({ leads });
    const invalid = { valid: false, reason: 'invalid', reissueAllowed: true };
    for (const handle of [leadId(7), leadId(8), leadId(9)]) {
      expect(await service.openEstimate({ token: 'household-token', handle })).toEqual(invalid);
    }
    expect(magicLinks.issued).toBe(0);
  });

  it('AC3: partner-share, expired and malformed requests open nothing', async () => {
    const { service, magicLinks } = setup();
    magicLinks.byToken.set('partner', linkRecord({ purpose: 'partner-share', household: true }));
    magicLinks.byToken.set(
      'expired',
      linkRecord({ household: true, expiresAt: new Date(NOW.getTime() - 1) }),
    );
    expect((await service.openEstimate({ token: 'partner', handle: leadId(2) })).valid).toBe(false);
    expect(await service.openEstimate({ token: 'expired', handle: leadId(2) })).toMatchObject({
      valid: false,
      reason: 'expired',
    });
    expect((await service.openEstimate({ token: 'household-token', handle: 'nope' })).valid).toBe(false);
    expect((await service.openEstimate(null)).valid).toBe(false);
    expect(magicLinks.issued).toBe(0);
  });

  it('flags the minted link for the sandbox purge when the target lead is sandbox', async () => {
    const leads = [
      ...householdLeads(1),
      leadFixture({ id: leadId(2), addressKey: 'z', sandbox: true }),
    ];
    const { service, magicLinks } = setup({ leads });
    await service.openEstimate({ token: 'household-token', handle: leadId(2) });
    expect(magicLinks.issuedArgs[0]).toMatchObject({ sandbox: true });
  });
});
