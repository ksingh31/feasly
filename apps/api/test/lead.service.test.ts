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
import type {
  IssuedMagicLink,
  MagicLinkRecord,
  MagicLinkStore,
} from '../src/services/magic-link.store';
import { HttpError } from '../src/middleware/errors';

const ESTIMATE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-09-24T12:00:00Z');

/** Minimal magic-link fake: records issuance, never used for verification here. */
function fakeMagicLinkStore(): MagicLinkStore & {
  issued: { token: string; leadId: string }[];
} {
  const issued: { token: string; leadId: string }[] = [];
  return {
    issued,
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
    findByLeadIds: async () => [] as MagicLinkRecord[],
    revokeByLeadIds: async () => 0,
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
  };
  return {
    save: async () => {},
    findById: async (id: string) => (id === ESTIMATE_ID ? record : null),
  };
}

interface FakeLeadStore extends LeadStore {
  inserted: NewLead[];
  recent: LeadRecord | null;
}

function fakeLeadStore(): FakeLeadStore {
  const inserted: NewLead[] = [];
  let recent: LeadRecord | null = null;
  return {
    inserted,
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
      return found
        ? {
            ...found,
            phone: found.phone ?? null,
            tenantKey: found.tenantKey ?? null,
            quarantined: false,
            createdAt: NOW,
          }
        : null;
    },
    findAllByEmail: async (email: string) =>
      inserted
        .filter((l) => l.email === email)
        .map((l) => ({
          ...l,
          phone: l.phone ?? null,
          tenantKey: l.tenantKey ?? null,
          quarantined: false,
          createdAt: NOW,
        })),
    deleteByEmail: async (email: string) => {
      const before = inserted.length;
      for (let i = inserted.length - 1; i >= 0; i--) {
        if (inserted[i]?.email === email) inserted.splice(i, 1);
      }
      return before - inserted.length;
    },
    insert: async (lead: NewLead) => {
      inserted.push(lead);
      return {
        ...lead,
        phone: lead.phone ?? null,
        tenantKey: lead.tenantKey ?? null,
        quarantined: lead.quarantined ?? false,
        createdAt: NOW,
      };
    },
  };
}

const DEPS = {
  estimateStore: fakeEstimateStore(),
  magicLinks: fakeMagicLinkStore(),
  dedupWindowDays: 90,
  magicLinkTtlSeconds: 900,
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
    const service = createLeadService({ ...DEPS, store });
    const result = await service.submitLead(VALID_BODY);

    expect(Object.keys(result).sort()).toEqual(
      ['expiresInDays', 'leadId', 'magicLinkSent'].sort(),
    );
    expect(result.leadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.magicLinkSent).toBe(false);
    // 900s TTL → 1 day, derived from config, never hardcoded.
    expect(result.expiresInDays).toBe(1);

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
  });

  it('normalizes the email before dedup and insert', async () => {
    const store = fakeLeadStore();
    const seen: Array<{ email: string; addressKey: string }> = [];
    store.findRecentByEmailAndAddress = async (args) => {
      seen.push({ email: args.email, addressKey: args.addressKey });
      return null;
    };
    const service = createLeadService({ ...DEPS, store });
    await service.submitLead({ ...VALID_BODY, email: '  Sam@Example.COM ' });
    expect(store.inserted[0].email).toBe('sam@example.com');
    // Normalized email + the estimate's addressKey drive the dedup lookup.
    expect(seen).toEqual([
      { email: 'sam@example.com', addressKey: 'calgary-123-fake-st-nw' },
    ]);
    expect(store.inserted[0].addressKey).toBe('calgary-123-fake-st-nw');
  });

  it('returns the existing lead without inserting a duplicate inside the window', async () => {
    const store = fakeLeadStore();
    store.recent = {
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
      createdAt: NOW,
    };
    const service = createLeadService({ ...DEPS, store });
    const result = await service.submitLead(VALID_BODY);
    expect(result.leadId).toBe('existing-lead-id');
    expect(result.magicLinkSent).toBe(false);
    expect(store.inserted).toHaveLength(0);
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
            }
          : null,
    };
    const store = fakeLeadStore();
    store.recent = {
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
      createdAt: NOW,
    };
    const service = createLeadService({ ...DEPS, store, estimateStore });
    const result = await service.submitLead({
      ...VALID_BODY,
      estimateId: OTHER_ESTIMATE,
    });
    expect(result.leadId).toBe('existing-lead-id');
    expect(store.inserted).toHaveLength(0);
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
    // Bots learn nothing: same keys, same magicLinkSent, no quarantine hint.
    expect(Object.keys(trapped).sort()).toEqual(Object.keys(clean).sort());
    expect(trapped.magicLinkSent).toBe(false);
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
      store.inserted.length > 0
        ? {
            ...store.inserted[0],
            phone: store.inserted[0].phone ?? null,
            tenantKey: store.inserted[0].tenantKey ?? null,
            quarantined: store.inserted[0].quarantined ?? false,
            createdAt: NOW,
          }
        : null;
    const service = createLeadService({ ...DEPS, store });
    const first = await service.submitLead(VALID_BODY);
    const second = await service.submitLead(VALID_BODY);
    expect(second.leadId).toBe(first.leadId);
    expect(store.inserted).toHaveLength(1);
  });
});
