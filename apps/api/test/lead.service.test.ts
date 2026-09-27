/**
 * Lead service tests (BE3-003).
 *
 * Covers: happy-path capture returning the contracts `LeadResponse`, Zod
 * validation (email required, phone optional, CASL unchecked honored),
 * unknown estimateId rejection, 90-day dedup returning the existing lead
 * without a duplicate insert, email normalization, PII never appearing in
 * error messages, and `expiresInDays` derived from config (never hardcoded).
 *
 * The stores are faked at the interface boundary; the real Drizzle stores
 * are covered against PGlite in db-migrations.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createLeadService } from '../src/services/lead.service';
import type { EstimateRecord, EstimateStore } from '../src/services/estimate.store';
import type { LeadRecord, LeadStore, NewLead } from '../src/services/lead.store';
import type { UnsubscribeService } from '../src/services/unsubscribe.service';
import type {
  IssuedMagicLink,
  MagicLinkRecord,
  MagicLinkStore,
} from '../src/services/magic-link.store';
import type {
  EmailService,
  MagicLinkEmailInput,
} from '../src/services/email/email.service';
import type { EmailDelivery } from '../src/services/email/email.service';
import { HttpError } from '../src/middleware/errors';

const ESTIMATE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-09-24T12:00:00Z');
const APP_BASE_URL = 'https://feasly.example';

/** Minimal magic-link fake: records issuance, never used for verification here. */
function fakeMagicLinkStore(): MagicLinkStore & {
  issued: { token: string; leadId: string | null }[];
  /** Pre-seeded rows returned by findByLeadIds (live/expired scenarios). */
  seededLinks: MagicLinkRecord[];
} {
  const issued: { token: string; leadId: string | null }[] = [];
  const seededLinks: MagicLinkRecord[] = [];
  return {
    issued,
    seededLinks,
    issue: async (args) => {
      const record: IssuedMagicLink = {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        token: `raw-token-for-${args.leadId}`,
        expiresAt: new Date(NOW.getTime() + args.ttlSeconds * 1000),
      };
      issued.push({ token: record.token, leadId: args.leadId });
      return record;
    },
    findByToken: async () => null,
    findByLeadIds: async () => seededLinks,
    revokeByLeadIds: async () => 0,
    markUsed: async () => true,
  };
}

function liveLink(leadId: string): MagicLinkRecord {
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    leadId,
    purpose: 'lead',
    email: null,
    tokenHash: 'hash-live',
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    usedAt: null,
    revokedAt: null,
    createdAt: NOW,
  };
}

function expiredLink(leadId: string): MagicLinkRecord {
  return {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    leadId,
    purpose: 'lead',
    email: null,
    tokenHash: 'hash-expired',
    expiresAt: new Date(NOW.getTime() - 86_400_000),
    usedAt: null,
    revokedAt: null,
    createdAt: new Date(NOW.getTime() - 8 * 86_400_000),
  };
}

/** Email fake: records magic-link sends, everything else no-ops. */
function fakeEmailService(): EmailService & {
  magicLinkSends: MagicLinkEmailInput[];
} {
  const magicLinkSends: MagicLinkEmailInput[] = [];
  const ok: EmailDelivery = { sent: true, provider: 'log', messageId: 'test-msg' };
  return {
    magicLinkSends,
    sendMagicLink: async (input: MagicLinkEmailInput) => {
      magicLinkSends.push(input);
      return ok;
    },
    sendPartnerShare: async () => ok,
    sendCallbackConfirmation: async () => ok,
    sendNudge: async () => ok,
    sendOpsAlert: async () => ok,
  };
}

function fakeEstimateStore(): EstimateStore {
  const record: EstimateRecord = {
    id: ESTIMATE_ID,
    projectType: 'new_build',
    addressKey: 'calgary-123-fake-st-nw',
    inputs: {},
    figures: {},
    rows: {},
    costDataVersion: 'v0.1.0-unclibrated',
    createdAt: NOW,
    narrative: null,
    narrativeGeneratedAt: null,
    assumptions: null,
  };
  return {
    save: async () => {},
    findById: async (id: string) => (id === ESTIMATE_ID ? record : null),
    setNarrative: async () => false,
    findByAddressKey: async () => [],
  };
}

interface FakeLeadStore extends LeadStore {
  inserted: NewLead[];
  recent: LeadRecord | null;
  /** updateOnRepeat call args, in order (consumer/02 field-matrix tests). */
  updated: Array<{
    id: string;
    name: string;
    phone?: string;
    timeline: string;
    leadScore: number;
    estimateId: string;
  }>;
  /** In-memory notes/history (consumer/02 preservation tests). */
  notes: Array<{ leadId: string; note: string }>;
  statusHistory: Array<{ leadId: string; oldStatus: string | null; newStatus: string }>;
}

function toFakeRecord(lead: NewLead): LeadRecord {
  return {
    ...lead,
    phone: lead.phone ?? null,
    tenantKey: lead.tenantKey ?? null,
    quarantined: lead.quarantined ?? false,
    sandbox: lead.sandbox ?? false,
    leadScore: 0,
    status: 'new',
    unsubscribedAt: null,
    contactOptOutAt: null,
    consentUpdatedAt: NOW,
    nudgeSentAt: null,
    sheetsSyncedAt: null,
    updatedAt: NOW,
    createdAt: NOW,
  };
}

function fakeLeadStore(): FakeLeadStore {
  const inserted: NewLead[] = [];
  const updated: FakeLeadStore['updated'] = [];
  const notes: FakeLeadStore['notes'] = [];
  const statusHistory: FakeLeadStore['statusHistory'] = [];
  /** email/03: opt-out timestamps by lead id (mirrors leads.unsubscribed_at). */
  const unsubscribed = new Map<string, Date>();
  let recent: LeadRecord | null = null;
  return {
    inserted,
    updated,
    notes,
    statusHistory,
    get recent() {
      return recent;
    },
    set recent(value: LeadRecord | null) {
      recent = value;
    },
    findRecentByEmailAndAddress: async () => recent,
    listLeads: async () => [],
    findById: async (id: string) => {
      const found = inserted.find((l) => l.id === id);
      if (!found) return null;
      const record = toFakeRecord(found);
      const stamped = unsubscribed.get(id);
      return stamped ? { ...record, unsubscribedAt: stamped } : record;
    },
    findByEstimateId: async (estimateId: string) => {
      const found = inserted.find((l) => l.estimateId === estimateId);
      return found ? toFakeRecord(found) : null;
    },
    setUnsubscribedAt: async (args: { id: string; at: Date }) => {
      const found = inserted.find((l) => l.id === args.id);
      if (!found) return null;
      // Mirror the real store: only stamp when NULL (first opt-out wins).
      const stamped = unsubscribed.get(args.id) ?? args.at;
      unsubscribed.set(args.id, stamped);
      return { ...toFakeRecord(found), unsubscribedAt: stamped };
    },
    findNudgeCandidates: async () => [],
    setNudgeSentAt: async () => null,
    findAllByEmail: async (email: string) =>
      inserted.filter((l) => l.email === email).map(toFakeRecord),
    deleteByEmail: async (email: string) => {
      const before = inserted.length;
      for (let i = inserted.length - 1; i >= 0; i--) {
        if (inserted[i]?.email === email) inserted.splice(i, 1);
      }
      return before - inserted.length;
    },
    findSheetsSyncCandidates: async () => [],
    setSheetsSyncedAt: async () => null,
    countNeverSynced: async () => 0,
      listByTenantKey: async () => [],
      updateStatus: async () => null,
      updateConsentPreferences: async () => null,
    insert: async (lead: NewLead) => {
      inserted.push(lead);
      return toFakeRecord(lead);
    },
    updateOnRepeat: async (args) => {
      updated.push({ ...args });
      // Apply to the fixture so later reads see the refreshed scalars.
      if (recent && recent.id === args.id) {
        recent = {
          ...recent,
          name: args.name,
          phone: args.phone ?? null,
          timeline: args.timeline,
          leadScore: args.leadScore,
          estimateId: args.estimateId,
        };
      }
      return recent ?? toFakeRecord(inserted[0] as NewLead);
    },
    findNewestEstimateIdByEmailAndAddress: async () => null,
    appendNote: async (args) => {
      notes.push({ leadId: args.leadId, note: args.note });
    },
    getNotes: async (leadId: string) =>
      notes
        .filter((n) => n.leadId === leadId)
        .map((n) => ({ note: n.note, createdAt: NOW })),
    appendStatusHistory: async (args) => {
      statusHistory.push({
        leadId: args.leadId,
        oldStatus: args.oldStatus,
        newStatus: args.newStatus,
      });
    },
    getStatusHistory: async (leadId: string) =>
      statusHistory
        .filter((h) => h.leadId === leadId)
        .map((h) => ({
          oldStatus: h.oldStatus,
          newStatus: h.newStatus,
          changedBy: null,
          changedAt: NOW,
        })),
  };
}

/** consumer/02: an existing in-window lead the dedupe lookup returns. */
function existingLeadFixture(overrides?: Partial<LeadRecord>): LeadRecord {
  return {
    id: 'existing-lead-id',
    estimateId: ESTIMATE_ID,
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
    contactOptOutAt: null,
    consentUpdatedAt: NOW,
    nudgeSentAt: null,
    sheetsSyncedAt: null,
    updatedAt: NOW,
    createdAt: NOW,
    ...overrides,
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

const DEPS = {
  unsubscribe: fakeUnsubscribe,
  estimateStore: fakeEstimateStore(),
  magicLinks: fakeMagicLinkStore(),
  email: fakeEmailService(),
  appBaseUrl: APP_BASE_URL,
  dedupWindowDays: 90,
  magicLinkTtlSeconds: 900,
  // EMB-03: the fake knows 'elite-craft' (used by the tenantKey test).
  builderConfigs: {
    getByKey: async (key: string) => {
      if (key !== 'elite-craft') {
        throw new HttpError(404, 'UNKNOWN_TENANT', 'Unknown tenant.', false);
      }
      return {
        business_name: 'Elite Craft',
        display_name: 'Elite Craft',
        logo_url: '',
        accent_color: '#b08d57',
        allowed_origins: [],
        fallback_phone: '',
        fallback_email: '',
        plan: null,
      };
    },
  },
  clock: () => NOW,
};

const VALID_BODY = {
  email: 'sam@example.com',
  name: 'Sam',
  marketingConsent: false,
  estimateId: ESTIMATE_ID,
};

describe('lead service', () => {
  it('captures a lead and returns the contracts LeadResponse shape', async () => {
    const store = fakeLeadStore();
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, email });
    const result = await service.submitLead(VALID_BODY);

    expect(Object.keys(result).sort()).toEqual(
      ['expiresInDays', 'leadId', 'magicLinkSent', 'reportToken'].sort(),
    );
    expect(result.leadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // consumer/02: the BE-5/email seam is wired — the magic-link email goes
    // out on capture (log provider in dev/test).
    expect(result.magicLinkSent).toBe(true);
    // Contact-optout: the consumer magic-link email carries the tokenized
    // preference-page URL in its footer.
    expect(email.magicLinkSends).toHaveLength(1);
    expect(email.magicLinkSends[0]!.unsubscribeUrl).toBe(
      `https://app.test/unsubscribe/tok-${result.leadId}`,
    );
    // Karan directive 2026-09-27 (immediate unlock): the raw owner token is
    // returned with the response so the same-session report can use the
    // token-gated extras without the email round-trip.
    expect(typeof result.reportToken).toBe('string');
    expect(result.reportToken!.length).toBeGreaterThan(0);
    // 900s TTL → 1 day, derived from config, never hardcoded.
    expect(result.expiresInDays).toBe(1);

    expect(email.magicLinkSends).toHaveLength(1);
    const sent = email.magicLinkSends[0]!;
    expect(sent.to).toBe('sam@example.com');
    expect(sent.audience).toBe('consumer');
    expect(sent.expiresInDays).toBe(1);
    expect(sent.magicLinkUrl.startsWith('https://feasly.example/r/')).toBe(true);
    expect(sent.magicLinkUrl.length).toBeGreaterThan('https://feasly.example/r/'.length);

    expect(store.inserted).toHaveLength(1);
    const saved = store.inserted[0];
    expect(saved.email).toBe('sam@example.com');
    expect(saved.name).toBe('Sam');
    expect(saved.marketingConsent).toBe(false);
    expect(saved.timeline).toBe('exploring');
    expect(saved.estimateId).toBe(ESTIMATE_ID);
    expect(saved.consentTs).toBe(NOW);
  });

  it('accepts optional phone, timeline, and tenantKey', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    await service.submitLead({
      ...VALID_BODY,
      phone: '+1 403-555-0100',
      timeline: '3-6mo',
      tenantKey: 'elite-craft',
    });
    const saved = store.inserted[0];
    expect(saved.phone).toBe('+1 403-555-0100');
    expect(saved.timeline).toBe('3-6mo');
    expect(saved.tenantKey).toBe('elite-craft');
    // EMB-03: a validated tenant key marks the lead as embed-sourced.
    expect(saved.source).toBe('embed');
  });

  it('normalizes the email before dedup and insert', async () => {
    const store = fakeLeadStore();
    const seen: Array<{ email: string; addressKey: string; tenantKey: string | null }> = [];
    store.findRecentByEmailAndAddress = async (args) => {
      seen.push({ email: args.email, addressKey: args.addressKey, tenantKey: args.tenantKey });
      return null;
    };
    const service = createLeadService({ ...DEPS, store });
    await service.submitLead({ ...VALID_BODY, email: '  Sam@Example.COM ' });
    expect(store.inserted[0].email).toBe('sam@example.com');
    // Normalized email + the estimate's addressKey drive the dedup lookup,
    // tenant-scoped (null = the direct site).
    expect(seen).toEqual([
      { email: 'sam@example.com', addressKey: 'calgary-123-fake-st-nw', tenantKey: null },
    ]);
    expect(store.inserted[0].addressKey).toBe('calgary-123-fake-st-nw');
  });

  it('scopes the dedupe lookup to the embed tenant — another tenant\'s lead is never rewritten', async () => {
    const store = fakeLeadStore();
    const tenantALead = existingLeadFixture({ id: 'tenant-a-lead', tenantKey: 'tenant-a' });
    const seenScopes: Array<string | null> = [];
    store.findRecentByEmailAndAddress = async (args) => {
      seenScopes.push(args.tenantKey);
      // Mirror the real store's tenant-scoped lookup: only the same
      // tenant's lead matches.
      return args.tenantKey === 'tenant-a' ? tenantALead : null;
    };
    const magicLinks = fakeMagicLinkStore();
    const service = createLeadService({ ...DEPS, store, magicLinks });
    // 'elite-craft' is the tenant key the DEPS builderConfigs fake knows.
    const result = await service.submitLead({
      ...VALID_BODY,
      tenantKey: 'elite-craft',
      name: 'Mallory',
    });
    // The lookup was scoped to the submitting tenant …
    expect(seenScopes).toEqual(['elite-craft']);
    // …so tenant A's lead was NOT matched: no rewrite, no owner token
    // minted for it — a fresh lead was inserted for the embed tenant.
    expect(store.updated).toHaveLength(0);
    expect(magicLinks.issued.filter((i) => i.leadId === 'tenant-a-lead')).toHaveLength(0);
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0].tenantKey).toBe('elite-craft');
    expect(store.inserted[0].source).toBe('embed');
    expect(result.leadId).toBe(store.inserted[0].id);
  });

  it('rejects a forged tenant key on the repeat path before the dedupe lookup', async () => {
    const store = fakeLeadStore();
    let lookupCalled = false;
    store.findRecentByEmailAndAddress = async () => {
      lookupCalled = true;
      return existingLeadFixture();
    };
    const service = createLeadService({ ...DEPS, store });
    await expect(
      service.submitLead({ ...VALID_BODY, tenantKey: 'forged-tenant' }),
    ).rejects.toThrow('Unknown tenant key.');
    // The 400 fires before any store read — no chance to touch the lead.
    expect(lookupCalled).toBe(false);
    expect(store.inserted).toHaveLength(0);
    expect(store.updated).toHaveLength(0);
  });

  it('resends the estimate email on a repeat submission even with a live link', async () => {
    const store = fakeLeadStore();
    store.recent = existingLeadFixture();
    // Karan directive 2026-09-27: EVERY genuine submission sends the
    // estimate email — a live link from an earlier submission must NOT
    // suppress the resend. (The old AC4 "zero new sends" rule stranded
    // users whose first email never arrived.)
    const magicLinks = fakeMagicLinkStore();
    magicLinks.seededLinks.push(liveLink('existing-lead-id'));
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, magicLinks, email });
    const result = await service.submitLead(VALID_BODY);
    expect(result.leadId).toBe('existing-lead-id');
    expect(result.magicLinkSent).toBe(true);
    expect(email.magicLinkSends).toHaveLength(1);
    expect(email.magicLinkSends[0]!.to).toBe('sam@example.com');
    // …and the in-tab client still gets a fresh working owner token for
    // the token-gated extras (share, callback, narrative, revise): the
    // live link's raw token is unrecoverable (hash-only storage), so the
    // resend mints a new one.
    expect(magicLinks.issued).toHaveLength(1);
    expect(typeof result.reportToken).toBe('string');
    expect(result.reportToken!.length).toBeGreaterThan(0);
    expect(store.inserted).toHaveLength(0);
    // …but the repeat submission still refreshes the lead's scalars.
    expect(store.updated).toHaveLength(1);
    expect(store.updated[0]).toMatchObject({ id: 'existing-lead-id' });
  });

  it('sends again on a second consecutive repeat submission (every submission sends)', async () => {
    const store = fakeLeadStore();
    store.recent = existingLeadFixture();
    const magicLinks = fakeMagicLinkStore();
    magicLinks.seededLinks.push(liveLink('existing-lead-id'));
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, magicLinks, email });

    const first = await service.submitLead(VALID_BODY);
    const second = await service.submitLead(VALID_BODY);

    expect(first.magicLinkSent).toBe(true);
    expect(second.magicLinkSent).toBe(true);
    // One email per genuine submission — the second is NOT suppressed as
    // a "duplicate", even with a live link from the first.
    expect(email.magicLinkSends).toHaveLength(2);
    expect(store.inserted).toHaveLength(0);
  });

  it('a send failure on the repeat path degrades gracefully — 200, lead saved, token returned, magicLinkSent false', async () => {
    const store = fakeLeadStore();
    store.recent = existingLeadFixture();
    const magicLinks = fakeMagicLinkStore();
    magicLinks.seededLinks.push(liveLink('existing-lead-id'));
    const email = fakeEmailService();
    email.sendMagicLink = async () => ({
      sent: false as const,
      provider: 'log' as const,
      failureReason: 'simulated ACS outage',
      emailError: 'delivery-failed' as const,
    });
    const service = createLeadService({ ...DEPS, store, magicLinks, email });

    // No throw: the lead row is updated, a fresh token is minted and
    // returned (the report still unlocks), and magicLinkSent: false tells
    // the client to show the "check your inbox or try again later" note.
    const result = await service.submitLead(VALID_BODY);
    expect(result.leadId).toBe('existing-lead-id');
    expect(result.magicLinkSent).toBe(false);
    expect(result.emailError).toBe('delivery-failed');
    expect(typeof result.reportToken).toBe('string');
    expect(result.reportToken!.length).toBeGreaterThan(0);
    expect(magicLinks.issued).toHaveLength(1);
    expect(store.updated).toHaveLength(1);
    // The failure is never reported as sent.
    expect(result.magicLinkSent).not.toBe(true);
  });

  it('an invalid-recipient send failure propagates emailError so the UI says "check for typos"', async () => {
    const store = fakeLeadStore();
    store.recent = existingLeadFixture();
    const magicLinks = fakeMagicLinkStore();
    magicLinks.seededLinks.push(liveLink('existing-lead-id'));
    const email = fakeEmailService();
    // Wrong email address: the provider classifies it non-retryable, so
    // deliver() returns the failure immediately (no retries).
    email.sendMagicLink = async () => ({
      sent: false as const,
      provider: 'log' as const,
      failureReason: 'invalid recipient',
      emailError: 'invalid-recipient' as const,
    });
    const service = createLeadService({ ...DEPS, store, magicLinks, email });

    const result = await service.submitLead(VALID_BODY);
    expect(result.magicLinkSent).toBe(false);
    expect(result.emailError).toBe('invalid-recipient');
    // The lead is still saved and the report still unlocks.
    expect(typeof result.reportToken).toBe('string');
    expect(result.reportToken!.length).toBeGreaterThan(0);
  });

  it('a send failure on the new-capture path degrades gracefully — the resubmission retries the send', async () => {
    const store = fakeLeadStore();
    const magicLinks = fakeMagicLinkStore();
    const email = fakeEmailService();
    let attempts = 0;
    email.sendMagicLink = async (input: MagicLinkEmailInput) => {
      attempts += 1;
      if (attempts === 1)
        return {
          sent: false as const,
          provider: 'log' as const,
          failureReason: 'simulated ACS outage',
          emailError: 'delivery-failed' as const,
        };
      return { sent: true as const, provider: 'log' as const, messageId: 'recovered' };
    };
    const service = createLeadService({ ...DEPS, store, magicLinks, email });

    // First attempt: the lead is captured, the token is issued and
    // returned, but the send failed — 200 with magicLinkSent: false, NOT
    // a 500. The report unlocks via reportToken.
    const first = await service.submitLead(VALID_BODY);
    expect(first.magicLinkSent).toBe(false);
    expect(first.emailError).toBe('delivery-failed');
    expect(typeof first.reportToken).toBe('string');
    expect(first.reportToken!.length).toBeGreaterThan(0);
    expect(store.inserted).toHaveLength(1);

    // The resubmission hits the dedupe path (same email + address) — and
    // with the resend fix it actually retries the email instead of
    // suppressing it.
    store.recent = existingLeadFixture({ id: store.inserted[0]!.id });
    const retry = await service.submitLead(VALID_BODY);
    expect(retry.magicLinkSent).toBe(true);
  });

  it('dedups across a fresh estimate for the same address (email + address, not estimate id)', async () => {
    const OTHER_ESTIMATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const estimateStore: EstimateStore = {
      save: async () => {},
      findById: async (id: string) =>
        id === OTHER_ESTIMATE
          ? {
              id: OTHER_ESTIMATE,
              projectType: 'new_build',
              // Same property as ESTIMATE_ID's fixture.
              addressKey: 'calgary-123-fake-st-nw',
              inputs: {},
              figures: {},
              rows: {},
              costDataVersion: 'v0.1.0-unclibrated',
              createdAt: NOW,
              narrative: null,
              narrativeGeneratedAt: null,
              assumptions: null,
            }
          : null,
      setNarrative: async () => false,
      findByAddressKey: async () => [],
    };
    const store = fakeLeadStore();
    store.recent = existingLeadFixture();
    const service = createLeadService({ ...DEPS, store, estimateStore });
    const result = await service.submitLead({
      ...VALID_BODY,
      estimateId: OTHER_ESTIMATE,
    });
    expect(result.leadId).toBe('existing-lead-id');
    expect(store.inserted).toHaveLength(0);
    // The repeat points the lead at the NEWEST estimate.
    expect(store.updated).toHaveLength(1);
    expect(store.updated[0]!.estimateId).toBe(OTHER_ESTIMATE);
  });

  it('rejects an invalid email with 400 and no PII in the message', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    const error = await service
      .submitLead({ ...VALID_BODY, email: 'not-an-email-address' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).not.toContain('not-an-email-address');
  });

  it('rejects a missing name with 400', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    const error = await service
      .submitLead({ ...VALID_BODY, name: '   ' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
  });

  it('rejects an unknown estimateId with 400', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    const error = await service
      .submitLead({ ...VALID_BODY, estimateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(store.inserted).toHaveLength(0);
  });

  it('rejects a malformed estimateId with 400', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    const error = await service
      .submitLead({ ...VALID_BODY, estimateId: 'nope' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
  });

  it('sanitizes store failures so submitted values never reach logs', async () => {
    const store = fakeLeadStore();
    store.findRecentByEmailAndAddress = async () => {
      throw new Error(
        'duplicate key value violates unique constraint "leads_x" Key (email)=(sam@example.com) already exists',
      );
    };
    const service = createLeadService({ ...DEPS, store });
    const error = await service.submitLead(VALID_BODY).catch((e) => e);
    expect(error).not.toBeInstanceOf(HttpError);
    expect(error.message).toBe('lead store lookup failed');
    expect(error.message).not.toContain('sam@example.com');
  });

  it('issues a magic-link bearer token on every captured lead (legal/02)', async () => {
    const magicLinks = fakeMagicLinkStore();
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store, magicLinks });
    const result = await service.submitLead(VALID_BODY);
    expect(magicLinks.issued).toHaveLength(1);
    expect(magicLinks.issued[0]!.leadId).toBe(result.leadId);
    expect(magicLinks.issued[0]!.token.length).toBeGreaterThan(0);
  });

  it('derives expiresInDays from a longer TTL', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({
      ...DEPS,
      store,
      magicLinkTtlSeconds: 3 * 86_400,
    });
    const result = await service.submitLead(VALID_BODY);
    expect(result.expiresInDays).toBe(3);
  });

  it('quarantines a honeypot-filled submission but answers with the normal shape', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    const clean = await service.submitLead(VALID_BODY);
    const trapped = await service.submitLead({
      ...VALID_BODY,
      email: 'bot@example.com',
      website: 'http://spam.example',
    });
    // Bots learn nothing: no quarantine hint in the shape. (magicLinkSent
    // differs — clean captures get the email, quarantined rows never do —
    // but the bot only ever sees its own response. reportToken follows the
    // same rule: clean captures get the owner token for the same-session
    // report, quarantined rows get no credential at all.)
    const cleanKeys = Object.keys(clean).filter((k) => k !== 'reportToken').sort();
    expect(Object.keys(trapped).sort()).toEqual(cleanKeys);
    expect(trapped.magicLinkSent).toBe(false);
    expect('reportToken' in trapped).toBe(false);
    expect(store.inserted).toHaveLength(2);
    expect(store.inserted[0].quarantined).toBe(false);
    expect(store.inserted[1].quarantined).toBe(true);
  });

  it('treats a blank honeypot field as a clean submission', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    await service.submitLead({ ...VALID_BODY, website: '   ' });
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0].quarantined).toBe(false);
  });

  it('a rapid double-submit still creates exactly one lead (regression)', async () => {
    const store = fakeLeadStore();
    // Second call sees the first call's row via the dedup lookup.
    store.findRecentByEmailAndAddress = async () =>
      store.inserted.length > 0 ? toFakeRecord(store.inserted[0]!) : null;
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, email });
    const first = await service.submitLead(VALID_BODY);
    const second = await service.submitLead(VALID_BODY);
    expect(second.leadId).toBe(first.leadId);
    expect(store.inserted).toHaveLength(1);
  });
});

describe('consumer/02 duplicate-estimate semantics', () => {
  it('updates exactly the allowed columns on a repeat estimate (field matrix)', async () => {
    const store = fakeLeadStore();
    store.recent = existingLeadFixture({
      name: 'Sam',
      phone: null,
      timeline: 'exploring',
      marketingConsent: false,
      status: 'contacted',
    });
    const magicLinks = fakeMagicLinkStore();
    magicLinks.seededLinks.push(liveLink('existing-lead-id'));
    const service = createLeadService({
      ...DEPS,
      store,
      magicLinks,
      email: fakeEmailService(),
    });
    const result = await service.submitLead({
      ...VALID_BODY,
      name: 'Samuel',
      phone: '+1 403-555-0100',
      timeline: '3-6mo',
      marketingConsent: true, // must NOT be clobbered
    });

    expect(result.leadId).toBe('existing-lead-id');
    expect(store.updated).toHaveLength(1);
    const update = store.updated[0]!;
    // Allowed: the repeat submission's fresh values.
    expect(update.name).toBe('Samuel');
    expect(update.phone).toBe('+1 403-555-0100');
    expect(update.timeline).toBe('3-6mo');
    expect(update.estimateId).toBe(ESTIMATE_ID);
    // …and nothing else: the update call carries exactly these columns.
    expect(Object.keys(update).sort()).toEqual(
      ['estimateId', 'id', 'leadScore', 'name', 'phone', 'timeline'].sort(),
    );
    // Protected: the stored row keeps its original values.
    expect(store.recent!.email).toBe('sam@example.com');
    expect(store.recent!.addressKey).toBe('calgary-123-fake-st-nw');
    expect(store.recent!.marketingConsent).toBe(false);
    expect(store.recent!.consentTs).toBe(NOW);
    expect(store.recent!.status).toBe('contacted');
    expect(store.recent!.quarantined).toBe(false);
    expect(store.recent!.createdAt).toBe(NOW);
  });

  it('recomputes lead_score from the latest submission on a repeat', async () => {
    const store = fakeLeadStore();
    store.recent = existingLeadFixture({ leadScore: 5 });
    const magicLinks = fakeMagicLinkStore();
    magicLinks.seededLinks.push(liveLink('existing-lead-id'));
    const service = createLeadService({
      ...DEPS,
      store,
      magicLinks,
      email: fakeEmailService(),
    });
    await service.submitLead({
      ...VALID_BODY,
      timeline: '0-3mo',
      phone: '+1 403-555-0100',
    });
    // 40 (0-3mo) + 0 (existing consent false — not clobbered) + 10 (phone).
    expect(store.updated[0]!.leadScore).toBe(50);
    expect(store.recent!.leadScore).toBe(50);
  });

  it('reissues the magic link and emails it when the existing link expired', async () => {
    const store = fakeLeadStore();
    store.recent = existingLeadFixture();
    const magicLinks = fakeMagicLinkStore();
    magicLinks.seededLinks.push(expiredLink('existing-lead-id'));
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, magicLinks, email });

    const result = await service.submitLead(VALID_BODY);

    expect(result.leadId).toBe('existing-lead-id');
    expect(result.magicLinkSent).toBe(true);
    expect(magicLinks.issued).toHaveLength(1);
    expect(email.magicLinkSends).toHaveLength(1);
    expect(email.magicLinkSends[0]!.to).toBe('sam@example.com');
  });

  it('reissues when the lead has no link at all', async () => {
    const store = fakeLeadStore();
    store.recent = existingLeadFixture();
    const magicLinks = fakeMagicLinkStore(); // seededLinks empty
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, magicLinks, email });

    const result = await service.submitLead(VALID_BODY);

    expect(result.magicLinkSent).toBe(true);
    expect(email.magicLinkSends).toHaveLength(1);
  });

  it('leaves quarantined leads untouched: no update, no email', async () => {
    const store = fakeLeadStore();
    store.recent = existingLeadFixture({ quarantined: true });
    const magicLinks = fakeMagicLinkStore();
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, magicLinks, email });

    const result = await service.submitLead({
      ...VALID_BODY,
      name: 'Bot Newname',
    });

    expect(result.leadId).toBe('existing-lead-id');
    expect(result.magicLinkSent).toBe(false);
    expect(store.updated).toHaveLength(0);
    expect(email.magicLinkSends).toHaveLength(0);
    expect(magicLinks.issued).toHaveLength(0);
  });

  it('treats a submission outside the dedupe window as a new lead', async () => {
    const store = fakeLeadStore();
    store.recent = null; // lookup found nothing inside the window
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, email });

    const result = await service.submitLead(VALID_BODY);

    expect(store.inserted).toHaveLength(1);
    expect(store.updated).toHaveLength(0);
    expect(result.leadId).toBe(store.inserted[0]!.id);
    expect(result.magicLinkSent).toBe(true);
  });
});
