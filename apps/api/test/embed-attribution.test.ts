/**
 * EMB-03 embed lead attribution contract tests.
 *
 * Covers the story's acceptance criteria:
 * 1. Embed lead → leads.tenant_key = the key's tenant, source='embed'
 *    (two tenants, asserting no cross-attribution).
 * 2. Client-supplied `tenant_id` in the lead POST is ignored/overridden
 *    server-side (forged tenant_id → attributed to the key's tenant anyway).
 * 3. Unknown tenant key → 400 (fail closed, never silently trusted).
 * 4. Non-embed leads keep source='api' and null tenant key.
 *
 * The BuilderConfigService is faked at the interface boundary: the fake
 * knows exactly two tenants ('acme-builders' and 'beta-homes'). Any other
 * key throws, mirroring the real service's 404 UNKNOWN_TENANT.
 */
import { describe, expect, it } from 'vitest';
import { createLeadService } from '../src/services/lead.service';
import type { BuilderConfigService } from '../src/services/builder-config.service';
import type { EstimateRecord, EstimateStore } from '../src/services/estimate.store';
import type { LeadRecord, LeadStore, NewLead } from '../src/services/lead.store';
import type {
  IssuedMagicLink,
  MagicLinkStore,
} from '../src/services/magic-link.store';
import type { EmailService } from '../src/services/email/email.service';
import type { EmailSendResult } from '../src/services/email/email.types';
import type { EmbedPublicConfig } from '@feasly/contracts';
import { HttpError, ErrorCodes } from '../src/middleware/errors';

const ESTIMATE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-09-24T12:00:00Z');
const APP_BASE_URL = 'https://feasly.example';

const ACME_CONFIG: EmbedPublicConfig = {
  business_name: 'Acme Builders Ltd.',
  display_name: 'Acme Builders',
  logo_url: '',
  accent_color: '#b08d57',
  allowed_origins: ['https://acme.example'],
  fallback_phone: '',
  fallback_email: '',
  plan: null,
};

const BETA_CONFIG: EmbedPublicConfig = {
  business_name: 'Beta Homes Inc.',
  display_name: 'Beta Homes',
  logo_url: '',
  accent_color: '#1a1a1a',
  allowed_origins: ['https://beta.example'],
  fallback_phone: '',
  fallback_email: '',
  plan: null,
};

/** Fake builder configs: exactly two known tenants. */
function fakeBuilderConfigs(): BuilderConfigService {
  const known = new Map<string, EmbedPublicConfig>([
    ['acme-builders', ACME_CONFIG],
    ['beta-homes', BETA_CONFIG],
  ]);
  return {
    getByKey: async (key: string) => {
      const config = known.get(key);
      if (!config) {
        throw new HttpError(404, ErrorCodes.UNKNOWN_TENANT, 'Unknown tenant.', false);
      }
      return config;
    },
  };
}

function fakeEstimateStore(): EstimateStore {
  const estimate: EstimateRecord = {
    id: ESTIMATE_ID,
    projectType: 'new_build',
    addressKey: 'calgary-123-main-st',
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v1',
    createdAt: NOW,
    narrative: null,
    narrativeGeneratedAt: null,
    assumptions: null,
  };
  return {
    save: async () => {},
    findById: async (id: string) => (id === ESTIMATE_ID ? estimate : null),
    setNarrative: async () => true,
  };
}

/** Fake lead store: records every insert for attribution assertions. */
function fakeLeadStore(): LeadStore & { inserted: NewLead[] } {
  const inserted: NewLead[] = [];
  const none = async () => null;
  const store = {
    inserted,
    findRecentByEmailAndAddress: none,
    findNewestEstimateIdByEmailAndAddress: none,
    insert: async (lead: NewLead) => {
      inserted.push(lead);
      const record: LeadRecord = {
        id: lead.id,
        estimateId: lead.estimateId,
        addressKey: lead.addressKey,
        email: lead.email,
        name: lead.name,
        phone: lead.phone ?? null,
        timeline: lead.timeline,
        marketingConsent: lead.marketingConsent,
        consentTs: lead.consentTs,
        tenantKey: lead.tenantKey ?? null,
        source: lead.source,
        quarantined: lead.quarantined ?? false,
        leadScore: 0,
        status: 'new',
        unsubscribedAt: null,
        nudgeSentAt: null,
        createdAt: NOW,
        sheetsSyncedAt: null,
        updatedAt: NOW,
      };
      return record;
    },
    updateOnRepeat: async () => {
      throw new Error('not used in attribution tests');
    },
    listLeads: async () => [],
    countLeads: async () => 0,
    findById: none,
    addNote: async () => {},
    listNotes: async () => [],
    setStatus: async () => {},
    listStatusHistory: async () => [],
  };
  return store as unknown as LeadStore & { inserted: NewLead[] };
}

function fakeMagicLinkStore(): MagicLinkStore {
  return {
    issue: async (args) => {
      const record: IssuedMagicLink = {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        token: `raw-token-for-${args.leadId}`,
        expiresAt: new Date(NOW.getTime() + args.ttlSeconds * 1000),
      };
      return record;
    },
    findByToken: async () => null,
    findByLeadIds: async () => [],
    revokeByLeadIds: async () => 0,
  };
}

function fakeEmailService(): EmailService {
  const result: EmailSendResult = { provider: 'log' };
  return {
    sendMagicLink: async () => result,
    sendNudge: async () => result,
    sendUnsubscribeConfirmation: async () => result,
    sendPartnerShare: async () => result,
    sendCallbackConfirmation: async () => result,
    sendOpsAlert: async () => result,
  } as EmailService;
}

const DEPS = {
  estimateStore: fakeEstimateStore(),
  magicLinks: fakeMagicLinkStore(),
  email: fakeEmailService(),
  appBaseUrl: APP_BASE_URL,
  dedupWindowDays: 90,
  magicLinkTtlSeconds: 900,
  builderConfigs: fakeBuilderConfigs(),
  clock: () => NOW,
};

const BASE_BODY = {
  email: 'homeowner@example.com',
  name: 'Homeowner',
  marketingConsent: false,
  estimateId: ESTIMATE_ID,
};

describe('EMB-03 embed lead attribution', () => {
  it('attributes an embed lead to the key tenant with source=embed', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });
    await service.submitLead({ ...BASE_BODY, tenantKey: 'acme-builders' });

    expect(store.inserted).toHaveLength(1);
    const lead = store.inserted[0]!;
    expect(lead.tenantKey).toBe('acme-builders');
    expect(lead.source).toBe('embed');
  });

  it('does not cross-attribute: two tenants stay separate', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });

    await service.submitLead({
      ...BASE_BODY,
      email: 'alice@example.com',
      tenantKey: 'acme-builders',
    });
    await service.submitLead({
      ...BASE_BODY,
      email: 'bob@example.com',
      tenantKey: 'beta-homes',
    });

    expect(store.inserted).toHaveLength(2);
    expect(store.inserted[0]!.tenantKey).toBe('acme-builders');
    expect(store.inserted[0]!.source).toBe('embed');
    expect(store.inserted[1]!.tenantKey).toBe('beta-homes');
    expect(store.inserted[1]!.source).toBe('embed');
  });

  it('ignores a forged tenant_id: the validated key wins', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });

    // An attacker adds tenant_id for a different tenant. The Zod schema
    // has no tenant_id field, so it is stripped; the validated tenantKey
    // is the only attribution signal.
    await service.submitLead({
      ...BASE_BODY,
      tenantKey: 'acme-builders',
      tenant_id: 'beta-homes',
    } as unknown as Record<string, unknown>);

    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]!.tenantKey).toBe('acme-builders');
    expect(store.inserted[0]!.source).toBe('embed');
  });

  it('rejects an unknown tenant key with 400 (fail closed)', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });

    await expect(
      service.submitLead({ ...BASE_BODY, tenantKey: 'evil-tenant' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.inserted).toHaveLength(0);
  });

  it('keeps direct leads on source=api with null tenant key', async () => {
    const store = fakeLeadStore();
    const service = createLeadService({ ...DEPS, store });

    await service.submitLead(BASE_BODY);

    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]!.tenantKey).toBeUndefined();
    expect(store.inserted[0]!.source).toBe('api');
  });
});
