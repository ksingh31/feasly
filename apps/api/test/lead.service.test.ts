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
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import { API_LEAD_CONSENT_VERSION } from '../src/lib/legal-copy';
import { BUILDER_STATUSES, BUILDER_STATUS_POLICY } from '@feasly/contracts';

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
    sendCommissionInvoiceOverdue: async () => ok,
    sendCardExpiryReminder: async () => ok,
    sendContractNeedsRecording: async () => ok,
    sendBuilderNewLead: async () => ok,
    sendBuilderNeedsYouDigest: async () => ok,
    sendErasureConfirmation: async () => ok,
  };
}

/** #793: a sandbox estimate at the same address as ESTIMATE_ID. */
const SANDBOX_ESTIMATE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
    findById: async (id: string) =>
      id === ESTIMATE_ID
        ? record
        : id === SANDBOX_ESTIMATE_ID
          ? { ...record, id, sandbox: true }
          : null,
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
    consentAttestedByApiKeyId: lead.consentAttestation?.apiKeyId ?? null,
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
    findByIdAndBuilderId: async ({
      id,
      builderId,
    }: {
      id: string;
      builderId: string;
    }) => {
      const found = inserted.find(
        (l) => l.id === id && toFakeRecord(l).builderId === builderId,
      );
      return found ? toFakeRecord(found) : null;
    },
    existsById: async (id: string) => inserted.some((l) => l.id === id),
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
      listByBuilderId: async () => [],
      updateStatus: async () => null,
      updateStatusForBuilder: async () => null,
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
  // Karan 2026-09-27: timeline is required — the API rejects a missing value.
  timeline: 'exploring',
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
    // #703: the report email names the property and states the issued
    // token's real expiry (900s TTL → NOW + 15 min).
    expect(sent.address).toBe('Calgary 123 Fake St NW');
    expect(sent.expiresOn).toEqual(new Date(NOW.getTime() + 900_000));
    // #823: the estimate's project type gates the new-build timeline block.
    expect(sent.projectType).toBe('new_build');
    // #785/#918: an own-site lead gets the Feasly-only find-a-community link.
    expect(sent.ownSite).toBe(true);

    expect(store.inserted).toHaveLength(1);
    const saved = store.inserted[0];
    expect(saved.email).toBe('sam@example.com');
    expect(saved.name).toBe('Sam');
    expect(saved.marketingConsent).toBe(false);
    expect(saved.timeline).toBe('exploring');
    expect(saved.estimateId).toBe(ESTIMATE_ID);
    expect(saved.consentTs).toBe(NOW);
  });

  it('accepts optional phone and tenantKey, and a non-default timeline', async () => {
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

  it('#785/#918: a builder-embed lead\'s report email omits the find-a-community link', async () => {
    const store = fakeLeadStore();
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, email });
    await service.submitLead({ ...VALID_BODY, tenantKey: 'elite-craft' });
    expect(email.magicLinkSends).toHaveLength(1);
    expect(email.magicLinkSends[0]!.ownSite).toBeUndefined();
  });

  it('#814: passes the sanitized campaign source to the insert', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    await service.submitLead({
      ...VALID_BODY,
      source: { utm_source: 'google', utm_campaign: 'spring', utm_term: 'a@b.co' },
    });
    expect(store.inserted[0].attribution).toEqual({
      utmSource: 'google',
      utmMedium: null,
      utmCampaign: 'spring',
      // PII-shaped value dropped, not stored.
      utmTerm: null,
      utmContent: null,
      clickIdType: null,
    });
  });

  it('#814: a malformed source never fails the capture', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    const result = await service.submitLead({ ...VALID_BODY, source: 'utm_source=google' });
    expect(result.leadId).toBeTruthy();
    expect(store.inserted[0].attribution?.utmSource).toBeNull();
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

  it('suppresses the email on an idempotent resubmit — one send per email + property (P0 2026-09-27)', async () => {
    // P0: Karan's lead-gate tap produced THREE identical "estimate is ready"
    // emails (ACS accepted the send, the delivery poll timed out, the
    // in-code retry re-sent twice). A repeat submission while the first
    // send is still fresh must NOT send again — the earlier link is still
    // live, so the client says "your link is already in your inbox".
    const store = fakeLeadStore();
    const magicLinks = fakeMagicLinkStore();
    const email = fakeEmailService();
    // Second call sees the first call's row via the dedup lookup.
    store.findRecentByEmailAndAddress = async () =>
      store.inserted.length > 0 ? toFakeRecord(store.inserted[0]!) : null;
    const service = createLeadService({ ...DEPS, store, magicLinks, email });

    const first = await service.submitLead(VALID_BODY);
    expect(first.magicLinkSent).toBe(true);
    expect(first.emailAlreadySent).toBeUndefined();

    // The resubmit (double tap / client-timeout retry / deliberate resend)
    // hits the repeat path: lead scalars refresh, a FRESH token is minted
    // for the in-tab client — but no second email goes out.
    const second = await service.submitLead(VALID_BODY);
    expect(second.leadId).toBe(first.leadId);
    expect(second.magicLinkSent).toBe(true);
    expect(second.emailAlreadySent).toBe(true);
    expect(email.magicLinkSends).toHaveLength(1);
    expect(store.inserted).toHaveLength(1);
    // …and the in-tab client still gets a fresh working owner token for
    // the token-gated extras (share, callback, narrative, revise): the
    // first link's raw token is unrecoverable (hash-only storage), so the
    // resubmit mints a new one.
    expect(magicLinks.issued).toHaveLength(2);
    expect(typeof second.reportToken).toBe('string');
    expect(second.reportToken!.length).toBeGreaterThan(0);
    // …and the repeat submission still refreshes the lead's scalars.
    expect(store.updated).toHaveLength(1);
    expect(store.updated[0]).toMatchObject({ id: first.leadId });
  });

  it('sends again on a resubmit when the earlier send FAILED — retries are never stranded', async () => {
    // A failed send is never recorded for suppression: the user who sees
    // "check your inbox or try again later" and resubmits must get a real
    // retry, not an "already in your inbox" dead end.
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
    store.findRecentByEmailAndAddress = async () =>
      store.inserted.length > 0 ? toFakeRecord(store.inserted[0]!) : null;
    const service = createLeadService({ ...DEPS, store, magicLinks, email });

    const first = await service.submitLead(VALID_BODY);
    expect(first.magicLinkSent).toBe(false);
    expect(first.emailAlreadySent).toBeUndefined();

    const retry = await service.submitLead(VALID_BODY);
    expect(retry.magicLinkSent).toBe(true);
    expect(retry.emailAlreadySent).toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('treats an accepted-but-unconfirmed send as sent for suppression (no duplicate on resubmit)', async () => {
    // ACS beginSend succeeded but the delivery poll timed out: deliver()
    // returns sent:false with acceptedByProvider:true (never re-sends).
    // The lead service must record it — otherwise the user's "try again"
    // resubmit would duplicate an already-delivered email.
    const store = fakeLeadStore();
    const magicLinks = fakeMagicLinkStore();
    const email = fakeEmailService();
    let attempts = 0;
    email.sendMagicLink = async (input: MagicLinkEmailInput) => {
      attempts += 1;
      return {
        sent: false as const,
        provider: 'log' as const,
        failureReason: 'delivery polling timed out (accepted, unconfirmed)',
        emailError: 'delivery-failed' as const,
        acceptedByProvider: true as const,
      };
    };
    store.findRecentByEmailAndAddress = async () =>
      store.inserted.length > 0 ? toFakeRecord(store.inserted[0]!) : null;
    const service = createLeadService({ ...DEPS, store, magicLinks, email });

    const first = await service.submitLead(VALID_BODY);
    expect(first.magicLinkSent).toBe(false);
    expect(first.emailError).toBe('delivery-failed');
    expect(typeof first.reportToken).toBe('string');

    // The resubmit is suppressed even though the first response reported a
    // failure — the email was accepted, so it probably arrived.
    const second = await service.submitLead(VALID_BODY);
    expect(second.emailAlreadySent).toBe(true);
    expect(attempts).toBe(1);
  });

  it('sends again on a resubmit after the suppression window (link TTL) expires', async () => {
    // A resubmit past the magic-link TTL is a genuinely new send: the old
    // link is dead, so "already in your inbox" would be a lie.
    let nowMs = NOW.getTime();
    const store = fakeLeadStore();
    const magicLinks = fakeMagicLinkStore();
    const email = fakeEmailService();
    store.findRecentByEmailAndAddress = async () =>
      store.inserted.length > 0 ? toFakeRecord(store.inserted[0]!) : null;
    const service = createLeadService({
      ...DEPS,
      store,
      magicLinks,
      email,
      clock: () => new Date(nowMs),
    });

    await service.submitLead(VALID_BODY);
    // Past the 900s TTL in DEPS.
    nowMs += 901_000;
    const resubmit = await service.submitLead(VALID_BODY);
    expect(resubmit.magicLinkSent).toBe(true);
    expect(resubmit.emailAlreadySent).toBeUndefined();
    expect(email.magicLinkSends).toHaveLength(2);
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
              // #823: a renovation re-estimate — the dedupe-path email must
              // carry its project type so the new-build timeline is hidden.
              projectType: 'renovation',
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
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, estimateStore, email });
    const result = await service.submitLead({
      ...VALID_BODY,
      estimateId: OTHER_ESTIMATE,
    });
    expect(result.leadId).toBe('existing-lead-id');
    expect(email.magicLinkSends.at(-1)?.projectType).toBe('renovation');
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

  it('rejects a missing timeline with 400 — no silent default (Karan 2026-09-27)', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    const { timeline: _omitted, ...noTimeline } = VALID_BODY;
    const error = await service.submitLead(noTimeline).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('timeline');
    // …and an invalid timeline value is rejected too.
    const badValue = await service
      .submitLead({ ...VALID_BODY, timeline: 'someday' })
      .catch((e) => e);
    expect(badValue).toBeInstanceOf(HttpError);
    expect(badValue.status).toBe(400);
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

  describe('#788 minimum time-to-submit', () => {
    it('quarantines a submission faster than minSubmitMs with the normal response shape', async () => {
      const store = fakeLeadStore();
      const email = fakeEmailService();
      const service = createLeadService({ ...DEPS, store, email, minSubmitMs: 3_000 });
      const clean = await service.submitLead({ ...VALID_BODY, elapsedMs: 12_000 });
      const fast = await service.submitLead({
        ...VALID_BODY,
        email: 'bot@example.com',
        elapsedMs: 150,
      });
      const cleanKeys = Object.keys(clean).filter((k) => k !== 'reportToken').sort();
      expect(Object.keys(fast).sort()).toEqual(cleanKeys);
      expect(fast.magicLinkSent).toBe(false);
      expect('reportToken' in fast).toBe(false);
      expect(store.inserted.map((l) => l.quarantined)).toEqual([false, true]);
      // No mail for the quarantined row.
      expect(email.magicLinkSends).toHaveLength(1);
    });

    it('treats exactly minSubmitMs as human', async () => {
      const store = fakeLeadStore();
      const service = createLeadService({ ...DEPS, store, minSubmitMs: 3_000 });
      await service.submitLead({ ...VALID_BODY, elapsedMs: 3_000 });
      expect(store.inserted[0].quarantined).toBe(false);
    });

    it('quarantines a negative (forged) timer instead of rejecting it', async () => {
      const store = fakeLeadStore();
      const service = createLeadService({ ...DEPS, store, minSubmitMs: 3_000 });
      await service.submitLead({ ...VALID_BODY, elapsedMs: -5 });
      expect(store.inserted[0].quarantined).toBe(true);
    });

    it('does not quarantine when elapsedMs is absent (agent API / older web bundles)', async () => {
      const store = fakeLeadStore();
      const service = createLeadService({ ...DEPS, store, minSubmitMs: 3_000 });
      await service.submitLead(VALID_BODY);
      expect(store.inserted[0].quarantined).toBe(false);
    });

    it('is disabled when minSubmitMs is 0 or unset', async () => {
      const store = fakeLeadStore();
      await createLeadService({ ...DEPS, store, minSubmitMs: 0 }).submitLead({
        ...VALID_BODY,
        elapsedMs: 1,
      });
      await createLeadService({ ...DEPS, store }).submitLead({
        ...VALID_BODY,
        email: 'other@example.com',
        elapsedMs: 1,
      });
      expect(store.inserted.map((l) => l.quarantined)).toEqual([false, false]);
    });

    it('rejects a non-numeric elapsedMs as a validation error', async () => {
      const service = createLeadService({ ...DEPS, store: fakeLeadStore(), minSubmitMs: 3_000 });
      await expect(
        service.submitLead({ ...VALID_BODY, elapsedMs: 'fast' }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  it('a rapid double-submit still creates exactly one lead and sends exactly one email (regression)', async () => {
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
    // P0 2026-09-27: the second submit is an idempotent resubmit — exactly
    // one "estimate is ready" email, never two.
    expect(email.magicLinkSends).toHaveLength(1);
    expect(second.emailAlreadySent).toBe(true);
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

describe('lead service: API-key callers (#738)', () => {
  const CALLER = { keyId: 'key-live-1', sandbox: false, surface: 'rest' as const };
  const ATTESTED = {
    ...VALID_BODY,
    consent: true,
    consentVersion: API_LEAD_CONSENT_VERSION,
  };

  it('AC5: rejects a lead without a consent attestation and stores nothing', async () => {
    for (const body of [
      VALID_BODY,
      { ...VALID_BODY, consent: false, consentVersion: API_LEAD_CONSENT_VERSION },
      { ...VALID_BODY, consent: true },
      { ...VALID_BODY, consent: 'yes', consentVersion: API_LEAD_CONSENT_VERSION },
    ]) {
      const store = fakeLeadStore();
      const email = fakeEmailService();
      const service = createLeadService({ ...DEPS, store, email });
      const error = await service.submitLead(body, CALLER).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe(ErrorCodes.CONSENT_REQUIRED);
      // PII: never echoes the submitted email.
      expect((error as HttpError).message).not.toContain('sam@example.com');
      expect(store.inserted).toHaveLength(0);
      expect(email.magicLinkSends).toHaveLength(0);
    }
  });

  it('AC5: rejects a stale consentVersion and names the current one', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({
      ...DEPS,
      store,
      apiLeads: { leadConsentVersion: 'api-lead-2027-01-01', quarantineLeads: true },
    });
    await expect(
      service.submitLead({ ...ATTESTED, consentVersion: API_LEAD_CONSENT_VERSION }, CALLER),
    ).rejects.toMatchObject({
      status: 400,
      code: ErrorCodes.CONSENT_REQUIRED,
      message: expect.stringContaining('api-lead-2027-01-01'),
    });
    expect(store.inserted).toHaveLength(0);
  });

  it('AC5: an accepted lead stores who attested, which wording, and when', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    await service.submitLead(ATTESTED, CALLER);
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]!.consentAttestation).toEqual({
      version: API_LEAD_CONSENT_VERSION,
      apiKeyId: 'key-live-1',
      attestedAt: NOW,
    });
    expect(store.inserted[0]!.source).toBe('api');
    expect(store.inserted[0]!.sandbox).toBe(false);
  });

  it('records source mcp for the MCP surface', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    await service.submitLead(ATTESTED, { ...CALLER, surface: 'mcp' });
    expect(store.inserted[0]!.source).toBe('mcp');
  });

  it('quarantines API-key leads for review: no email, no token (default policy)', async () => {
    const store = fakeLeadStore();
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, email });
    const result = await service.submitLead(ATTESTED, CALLER);
    expect(store.inserted[0]!.quarantined).toBe(true);
    expect(email.magicLinkSends).toHaveLength(0);
    expect(result).toEqual({ leadId: store.inserted[0]!.id, magicLinkSent: false, expiresInDays: 1 });
  });

  it('with quarantine off, a live-key lead is captured and emailed normally', async () => {
    const store = fakeLeadStore();
    const email = fakeEmailService();
    const service = createLeadService({
      ...DEPS,
      store,
      email,
      apiLeads: { leadConsentVersion: API_LEAD_CONSENT_VERSION, quarantineLeads: false },
    });
    const result = await service.submitLead(ATTESTED, CALLER);
    expect(store.inserted[0]!.quarantined).toBe(false);
    expect(result.magicLinkSent).toBe(true);
    expect(email.magicLinkSends).toHaveLength(1);
  });

  it('sandbox-key leads are sandbox rows and are never emailed', async () => {
    const store = fakeLeadStore();
    const email = fakeEmailService();
    const service = createLeadService({
      ...DEPS,
      store,
      email,
      apiLeads: { leadConsentVersion: API_LEAD_CONSENT_VERSION, quarantineLeads: false },
    });
    await service.submitLead(
      { ...ATTESTED, estimateId: SANDBOX_ESTIMATE_ID },
      { ...CALLER, sandbox: true },
    );
    expect(store.inserted[0]!.sandbox).toBe(true);
    expect(store.inserted[0]!.consentAttestation?.apiKeyId).toBe('key-live-1');
    // #793: the sandbox email decorator swallows every send.
    expect(email.magicLinkSends).toHaveLength(0);
  });

  it('a repeat for an existing lead never updates it, emails, or returns its token', async () => {
    const store = fakeLeadStore();
    store.recent = existingLeadFixture();
    const email = fakeEmailService();
    const magicLinks = fakeMagicLinkStore();
    const service = createLeadService({
      ...DEPS,
      store,
      email,
      magicLinks,
      apiLeads: { leadConsentVersion: API_LEAD_CONSENT_VERSION, quarantineLeads: false },
    });
    const result = await service.submitLead({ ...ATTESTED, name: 'Someone Else' }, CALLER);
    expect(result).toEqual({ leadId: 'existing-lead-id', magicLinkSent: false, expiresInDays: 1 });
    expect(store.updated).toHaveLength(0);
    expect(store.inserted).toHaveLength(0);
    expect(email.magicLinkSends).toHaveLength(0);
    expect(magicLinks.issued).toHaveLength(0);
  });

  /** Fake lookup mirroring the real store's sandbox-scoped dedupe. */
  function dedupeOverInserted(store: FakeLeadStore) {
    const seenSandbox: boolean[] = [];
    store.findRecentByEmailAndAddress = async (args) => {
      seenSandbox.push(args.sandbox ?? false);
      const match = [...store.inserted]
        .reverse()
        .find(
          (l) =>
            l.email === args.email &&
            l.addressKey === args.addressKey &&
            (l.sandbox ?? false) === args.sandbox,
        );
      return match ? toFakeRecord(match) : null;
    };
    return seenSandbox;
  }

  it('review fix: an API lead does not lock the person out — their own web submission gets a token and the email', async () => {
    const store = fakeLeadStore();
    dedupeOverInserted(store);
    const email = fakeEmailService();
    const magicLinks = fakeMagicLinkStore();
    const service = createLeadService({ ...DEPS, store, email, magicLinks });

    const apiResult = await service.submitLead(ATTESTED, CALLER);
    expect(store.inserted[0]!.quarantined).toBe(true);
    expect(email.magicLinkSends).toHaveLength(0);

    // The homeowner later fills in the gate on the site, same email + address.
    const web = await service.submitLead(VALID_BODY);
    expect(web.leadId).toBe(apiResult.leadId);
    expect(web.magicLinkSent).toBe(true);
    expect(typeof web.reportToken).toBe('string');
    expect(web.reportToken!.length).toBeGreaterThan(0);
    expect(email.magicLinkSends).toHaveLength(1);
    // Repeat path: scalars refreshed in place, no duplicate row.
    expect(store.updated).toHaveLength(1);
    expect(store.inserted).toHaveLength(1);
  });

  it('review fix: a honeypot-tripping web repeat onto an API row stays buried', async () => {
    const store = fakeLeadStore();
    dedupeOverInserted(store);
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, email });
    await service.submitLead(ATTESTED, CALLER);
    const bot = await service.submitLead({ ...VALID_BODY, website: 'http://spam.example' });
    expect(bot.magicLinkSent).toBe(false);
    expect(bot.reportToken).toBeUndefined();
    expect(store.updated).toHaveLength(0);
    expect(email.magicLinkSends).toHaveLength(0);
  });

  it('review fix: dedupe is sandbox-scoped — a real lead never dedupes onto a sandbox row', async () => {
    const store = fakeLeadStore();
    const seenSandbox = dedupeOverInserted(store);
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, email });

    await service.submitLead(
      { ...ATTESTED, estimateId: SANDBOX_ESTIMATE_ID },
      { ...CALLER, sandbox: true },
    );
    const web = await service.submitLead(VALID_BODY);

    expect(seenSandbox).toEqual([true, false]);
    // A fresh real row, not the test row the sandbox purge will delete.
    expect(store.inserted).toHaveLength(2);
    expect(store.inserted[1]!.sandbox).toBe(false);
    expect(web.leadId).toBe(store.inserted[1]!.id);
    expect(web.magicLinkSent).toBe(true);
    expect(email.magicLinkSends).toHaveLength(1);
  });

  it('web/embed submissions (no caller) need no attestation and store none', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    const result = await service.submitLead(VALID_BODY);
    expect(result.magicLinkSent).toBe(true);
    expect(store.inserted[0]!.quarantined).toBe(false);
    expect(store.inserted[0]!.consentAttestation).toBeUndefined();
  });
});

describe('#793 sandbox (feasly_test_ key) writes', () => {
  /** Magic-link fake that also records the sandbox flag of each issue. */
  function recordingMagicLinks() {
    const inner = fakeMagicLinkStore();
    const sandboxFlags: Array<boolean | undefined> = [];
    return {
      ...inner,
      sandboxFlags,
      issue: async (args: Parameters<MagicLinkStore['issue']>[0]) => {
        sandboxFlags.push(args.sandbox);
        return inner.issue(args);
      },
    };
  }

  /** A sandbox key's lead references a sandbox estimate. */
  const SANDBOX_BODY = { ...VALID_BODY, estimateId: SANDBOX_ESTIMATE_ID };

  it('a sandbox write is sandbox-flagged and sends no email', async () => {
    const store = fakeLeadStore();
    const email = fakeEmailService();
    const magicLinks = recordingMagicLinks();
    const lookups: Array<boolean | undefined> = [];
    store.findRecentByEmailAndAddress = async (args) => {
      lookups.push(args.sandbox);
      return null;
    };
    const service = createLeadService({ ...DEPS, store, email, magicLinks });
    const result = await service.submitLead(SANDBOX_BODY, { sandbox: true });

    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]!.sandbox).toBe(true);
    expect(magicLinks.sandboxFlags).toEqual([true]);
    // Dedupe is scoped to sandbox rows — a test key never rewrites a real lead.
    expect(lookups).toEqual([true]);
    // No real email: the sandbox decorator swallowed the send.
    expect(email.magicLinkSends).toHaveLength(0);
    // The response shape is unchanged for the integrating agent developer.
    expect(result.magicLinkSent).toBe(true);
    expect(typeof result.reportToken).toBe('string');
  });

  it('a live write is not sandbox-flagged and sends the email', async () => {
    const store = fakeLeadStore();
    const email = fakeEmailService();
    const magicLinks = recordingMagicLinks();
    const lookups: Array<boolean | undefined> = [];
    store.findRecentByEmailAndAddress = async (args) => {
      lookups.push(args.sandbox);
      return null;
    };
    const service = createLeadService({ ...DEPS, store, email, magicLinks });
    await service.submitLead(VALID_BODY);

    expect(store.inserted[0]!.sandbox).toBe(false);
    expect(magicLinks.sandboxFlags).toEqual([undefined]);
    expect(lookups).toEqual([false]);
    expect(email.magicLinkSends).toHaveLength(1);
  });

  it('a sandbox repeat (dedupe hit) sends no email and flags the reissued link', async () => {
    const store = fakeLeadStore();
    store.recent = existingLeadFixture({ sandbox: true });
    const email = fakeEmailService();
    const magicLinks = recordingMagicLinks();
    const service = createLeadService({ ...DEPS, store, email, magicLinks });
    const result = await service.submitLead(SANDBOX_BODY, { sandbox: true });

    expect(store.updated).toHaveLength(1);
    expect(magicLinks.sandboxFlags).toEqual([true]);
    expect(email.magicLinkSends).toHaveLength(0);
    expect(result.magicLinkSent).toBe(true);
  });

  it('a suppressed sandbox send never masks a later real send for the same email + property', async () => {
    const store = fakeLeadStore();
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, email });
    await service.submitLead(SANDBOX_BODY, { sandbox: true });
    await service.submitLead(VALID_BODY);
    expect(email.magicLinkSends).toHaveLength(1);
  });

  it('the sandbox flag is never read from the request body', async () => {
    const store = fakeLeadStore();
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, email });
    await service.submitLead({ ...VALID_BODY, sandbox: true });
    expect(store.inserted[0]!.sandbox).toBe(false);
    expect(email.magicLinkSends).toHaveLength(1);
  });

  it('rejects a lead whose sandbox mode does not match its estimate', async () => {
    const store = fakeLeadStore();
    const email = fakeEmailService();
    const service = createLeadService({ ...DEPS, store, email });
    // Live key → sandbox estimate: would block the sandbox purge (RESTRICT FK).
    await expect(service.submitLead(SANDBOX_BODY)).rejects.toMatchObject({ status: 400 });
    // Sandbox key → live estimate: would leak test traffic onto real data.
    await expect(service.submitLead(VALID_BODY, { sandbox: true })).rejects.toMatchObject({
      status: 400,
    });
    expect(store.inserted).toHaveLength(0);
    expect(email.magicLinkSends).toHaveLength(0);
  });
});

describe('#725 builder new-lead notification hook', () => {
  const BUILDER_ID = '99999999-9999-4999-8999-999999999999';
  const builders = {
    getByTenantKey: async (key: string) =>
      key === 'elite-craft' ? { id: BUILDER_ID, tenantKey: key, status: 'active' } : null,
  } as unknown as NonNullable<Parameters<typeof createLeadService>[0]['builders']>;

  function notifier() {
    const calls: Array<{ leadId: string; builderId: string }> = [];
    return {
      calls,
      notifyNewLead: async (args: { leadId: string; builderId: string }) => {
        calls.push(args);
      },
    };
  }

  it('notifies the builder once for a new embed lead', async () => {
    const store = fakeLeadStore();
    const builderNotifier = notifier();
    const service = createLeadService({ ...DEPS, store, builders, builderNotifier });
    const result = await service.submitLead({ ...VALID_BODY, tenantKey: 'elite-craft' });
    expect(builderNotifier.calls).toEqual([{ leadId: result.leadId, builderId: BUILDER_ID }]);
  });

  it('a notifier failure never fails lead capture', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({
      ...DEPS,
      store,
      builders,
      builderNotifier: {
        notifyNewLead: () => new Promise<void>(() => {}), // never settles
      },
    });
    const result = await service.submitLead({ ...VALID_BODY, tenantKey: 'elite-craft' });
    expect(result.leadId).toBeDefined();
  });

  it('no notification for direct-site, quarantined, or repeat submissions', async () => {
    const store = fakeLeadStore();
    const builderNotifier = notifier();
    const service = createLeadService({ ...DEPS, store, builders, builderNotifier });
    await service.submitLead(VALID_BODY);
    await service.submitLead({
      ...VALID_BODY,
      email: 'bot@example.com',
      tenantKey: 'elite-craft',
      website: 'http://spam.example',
    });
    store.recent = existingLeadFixture({ tenantKey: 'elite-craft', builderId: BUILDER_ID });
    await service.submitLead({ ...VALID_BODY, tenantKey: 'elite-craft' });
    expect(builderNotifier.calls).toHaveLength(0);
  });
});

// #860: lead routing enforcement point — one test per builder status.
describe('#860 lead routing by builder status', () => {
  const BUILDER_ID = '99999999-9999-4999-8999-999999999999';

  it.each(BUILDER_STATUSES)('a %s builder\'s embed lead', async (status) => {
    const store = fakeLeadStore();
    const notified: string[] = [];
    const service = createLeadService({
      ...DEPS,
      store,
      builders: {
        getByTenantKey: async (key: string) =>
          key === 'elite-craft' ? { id: BUILDER_ID, tenantKey: key, status } : null,
      } as unknown as NonNullable<Parameters<typeof createLeadService>[0]['builders']>,
      builderNotifier: {
        notifyNewLead: async (args: { leadId: string; builderId: string }) => {
          notified.push(args.builderId);
        },
      },
    });
    const result = await service.submitLead({ ...VALID_BODY, tenantKey: 'elite-craft' });
    expect(result.leadId).toBeDefined();
    const inserted = store.inserted[0]!;
    if (BUILDER_STATUS_POLICY[status].newLeads) {
      expect(inserted).toMatchObject({ builderId: BUILDER_ID, tenantKey: 'elite-craft' });
      expect(notified).toEqual([BUILDER_ID]);
    } else {
      // Held: captured unassigned, lands in the admin queue, no notice.
      expect(inserted.builderId ?? null).toBeNull();
      expect(inserted.tenantKey ?? null).toBeNull();
      expect(notified).toEqual([]);
    }
  });
});
