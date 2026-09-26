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
  EmailService,
  MagicLinkEmailInput,
} from '../src/services/email/email.service';
import type { EmailSendResult } from '../src/services/email/email.types';
import { HttpError } from '../src/middleware/errors';

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
    unsubscribedAt: null,
    nudgeSentAt: null,
    sheetsSyncedAt: null,
    updatedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

interface FakeMagicLinks extends MagicLinkStore {
  issued: number;
  byToken: Map<string, MagicLinkRecord>;
  byLead: Map<string, MagicLinkRecord[]>;
}

function fakeMagicLinks(): FakeMagicLinks {
  const byToken = new Map<string, MagicLinkRecord>();
  const byLead = new Map<string, MagicLinkRecord[]>();
  let issued = 0;
  return {
    get issued() {
      return issued;
    },
    byToken,
    byLead,
    issue: async (args): Promise<IssuedMagicLink> => {
      issued += 1;
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
    findById: async (id: string) => (lead && lead.id === id ? lead : null),
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
      updateStatus: async () => null,
    appendNote: noop,
    getNotes: async () => [],
    appendStatusHistory: noop,
    getStatusHistory: async () => [],
  };
}

function fakeEmail(): EmailService & { sends: MagicLinkEmailInput[] } {
  const sends: MagicLinkEmailInput[] = [];
  const ok: EmailSendResult = { provider: 'log' };
  return {
    sends,
    sendMagicLink: async (input) => {
      sends.push(input);
      return ok;
    },
    sendPartnerShare: async () => ok,
    sendCallbackConfirmation: async () => ok,
    sendNudge: async () => ok,
    sendOpsAlert: async () => ok,
  };
}

function makeService(opts?: {
  magicLinks?: FakeMagicLinks;
  leads?: LeadStore;
  email?: EmailService & { sends: MagicLinkEmailInput[] };
  ttlSeconds?: number;
  reissueCooldownMs?: number;
  clock?: () => Date;
}) {
  const magicLinks = opts?.magicLinks ?? fakeMagicLinks();
  const leads = opts?.leads ?? fakeLeads();
  const email = opts?.email ?? fakeEmail();
  const service = createMagicLinkService({
    magicLinks,
    leads,
    email,
    appBaseUrl: APP_BASE_URL,
    magicLinkTtlSeconds: opts?.ttlSeconds ?? 7 * 86_400,
    magicLinkReissueCooldownMs: opts?.reissueCooldownMs ?? 60_000,
    clock: opts?.clock ?? (() => NOW),
  });
  return { service, magicLinks, leads, email };
}

describe('magic-link verify', () => {
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
  it('sends nothing when a live link exists (AC4)', async () => {
    const magicLinks = fakeMagicLinks();
    magicLinks.byLead.set(LEAD_ID, [linkRecord()]);
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
