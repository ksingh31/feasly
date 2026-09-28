/**
 * Builders-table embed portal visibility contract tests.
 *
 * GAP 1 (critical): the builder portal scopes its lead list by
 * `leads.builder_id`, but embed-created leads historically carried only
 * `leads.tenant_key`. Without a dual-write at capture, every embed lead
 * would vanish from the builder portal the moment the builders table
 * ships. These tests pin the contract end to end:
 *
 * 1. Embed lead for tenant A → the insert carries builder_id = A's
 *    builder id AND keeps tenant_key (billing/attribution still reads it).
 * 2. A's portal (`listLeads`) returns the lead; B's portal returns
 *    nothing (empty result, not 403).
 * 3. Non-embed leads keep a null builder_id.
 *
 * Fakes mirror `embed-attribution.test.ts` (two tenants: acme-builders,
 * beta-homes); the lead store is in-memory so the portal scoping query
 * runs against the same rows the capture wrote.
 */
import { describe, expect, it, vi } from 'vitest';
import { createLeadService } from '../src/services/lead.service';
import type { BuilderConfigService } from '../src/services/builder-config.service';
import type { BuilderService } from '../src/services/builder.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';
import { createBuilderLeadsService } from '../src/services/builder-leads.service';
import type { EstimateRecord, EstimateStore } from '../src/services/estimate.store';
import type { LeadRecord, LeadStore, NewLead } from '../src/services/lead.store';
import type { UnsubscribeService } from '../src/services/unsubscribe.service';
import type {
  IssuedMagicLink,
  MagicLinkStore,
} from '../src/services/magic-link.store';
import type { EmailService } from '../src/services/email/email.service';
import type { EmailDelivery } from '../src/services/email/email.service';
import type { EmbedPublicConfig } from '@feasly/contracts';
import { HttpError, ErrorCodes } from '../src/middleware/errors';

const ESTIMATE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-09-27T12:00:00Z');
const APP_BASE_URL = 'https://feasly.example';

const ACME_BUILDER_ID = '11111111-1111-4111-8111-111111111111';
const BETA_BUILDER_ID = '22222222-2222-4222-8222-222222222222';

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

function fakeBuilders(): BuilderService {
  const byTenantKey = new Map([
    ['acme-builders', ACME_BUILDER_ID],
    ['beta-homes', BETA_BUILDER_ID],
  ]);
  return {
    getByTenantKey: async (tenantKey: string) => {
      const id = byTenantKey.get(tenantKey);
      if (!id) return null;
      return {
        id,
        tenantKey,
        businessName: tenantKey,
        displayName: tenantKey,
        email: null,
        phone: null,
        logoUrl: null,
        accentColor: null,
        allowedOrigins: [],
        plan: null,
        status: 'active' as const,
        settings: {},
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
    },
  } as unknown as BuilderService;
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
    findByAddressKey: async (addressKey: string) =>
      addressKey === estimate.addressKey ? [estimate] : [],
    setNarrative: async () => true,
  };
}

/** In-memory lead store: capture writes the rows the portal reads. */
function fakeLeadStore() {
  const rows = new Map<string, LeadRecord>();
  const none = async () => null;
  const store = {
    findRecentByEmailAndAddress: none,
    findNewestEstimateIdByEmailAndAddress: none,
    insert: async (lead: NewLead) => {
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
        sandbox: lead.sandbox ?? false,
        leadScore: 0,
        status: 'new',
        builderId: lead.builderId ?? null,
        unsubscribedAt: null,
        contactOptOutAt: null,
        consentUpdatedAt: NOW,
        nudgeSentAt: null,
        sheetsSyncedAt: null,
        updatedAt: NOW,
        createdAt: NOW,
      };
      rows.set(record.id, record);
      return record;
    },
    updateOnRepeat: async (args: { id: string; builderId?: string | null }) => {
      const record = rows.get(args.id);
      if (!record) throw new Error('lead not found');
      const updated: LeadRecord = {
        ...record,
        builderId: args.builderId !== undefined ? args.builderId : record.builderId,
      };
      rows.set(args.id, updated);
      return updated;
    },
    listByBuilderId: async (args: { builderId: string }) =>
      [...rows.values()].filter(
        (r) => r.builderId === args.builderId && !r.quarantined,
      ),
    findById: async (id: string) => rows.get(id) ?? null,
    listLeads: async () => [],
    countLeads: async () => 0,
    addNote: async () => {},
    listNotes: async () => [],
    setStatus: async () => {},
    listStatusHistory: async () => [],
  };
  return { store: store as unknown as LeadStore, rows };
}

function fakeMagicLinkStore(): MagicLinkStore {
  return {
    issue: async (args) => {
      const record: IssuedMagicLink = {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        token: 'raw-token',
        expiresAt: new Date(NOW.getTime() + args.ttlSeconds * 1000),
      };
      return record;
    },
    findByToken: async () => null,
    findByLeadIds: async () => [],
    revokeByLeadIds: async () => 0,
    markUsed: async () => true,
  };
}

function fakeEmailService(): EmailService {
  const result: EmailDelivery = { sent: true, provider: 'log' };
  return {
    sendMagicLink: async () => result,
    sendNudge: async () => result,
    sendUnsubscribeConfirmation: async () => result,
    sendPartnerShare: async () => result,
    sendCallbackConfirmation: async () => result,
    sendOpsAlert: async () => result,
  } as EmailService;
}

const fakeUnsubscribe = {
  buildUnsubscribeUrl: (leadId: string) =>
    `https://app.test/unsubscribe/tok-${leadId}`,
} as unknown as UnsubscribeService;

const BASE_BODY = {
  email: 'homeowner@example.com',
  name: 'Homeowner',
  marketingConsent: true,
  estimateId: ESTIMATE_ID,
};

function makeCaptureDeps() {
  const { store, rows } = fakeLeadStore();
  const builders = fakeBuilders();
  const service = createLeadService({
    store,
    estimateStore: fakeEstimateStore(),
    magicLinks: fakeMagicLinkStore(),
    email: fakeEmailService(),
    unsubscribe: fakeUnsubscribe,
    appBaseUrl: APP_BASE_URL,
    dedupWindowDays: 90,
    magicLinkTtlSeconds: 900,
    builderConfigs: fakeBuilderConfigs(),
    builders,
    clock: () => NOW,
  });
  return { service, store, rows, builders };
}

function makePortalDeps(store: LeadStore, builders: BuilderService) {
  const audit = { log: vi.fn(async () => {}) } as unknown as AdminAuditStore;
  return createBuilderLeadsService({ leadStore: store, audit, builders });
}

describe('embed → builder portal visibility (builders table)', () => {
  it('dual-writes builder_id on embed capture, keeping tenant_key', async () => {
    const { service, rows } = makeCaptureDeps();
    const result = await service.submitLead({ ...BASE_BODY, tenantKey: 'acme-builders' });

    expect(rows.size).toBe(1);
    const lead = rows.get(result.leadId)!;
    expect(lead.builderId).toBe(ACME_BUILDER_ID);
    expect(lead.tenantKey).toBe('acme-builders');
    expect(lead.source).toBe('embed');
  });

  it("tenant A's embed lead appears in A's portal; B's portal sees nothing", async () => {
    const { service, store, builders } = makeCaptureDeps();
    await service.submitLead({ ...BASE_BODY, tenantKey: 'acme-builders' });

    const portal = makePortalDeps(store, builders);
    const a = await portal.listLeads('acme-builders');
    expect(a.leads).toHaveLength(1);
    expect(a.summary.total).toBe(1);

    // Cross-builder invisibility is an empty result, not a 403.
    const b = await portal.listLeads('beta-homes');
    expect(b.leads).toHaveLength(0);
    expect(b.summary.total).toBe(0);
  });

  it('non-embed leads keep a null builder_id', async () => {
    const { service, rows } = makeCaptureDeps();
    const result = await service.submitLead({ ...BASE_BODY });

    const lead = rows.get(result.leadId)!;
    expect(lead.builderId).toBeNull();
    expect(lead.tenantKey).toBeNull();
  });

  it('repeat embed submission repairs a null builder_id', async () => {
    const { service, store, rows, builders } = makeCaptureDeps();
    void service;
    // Force the dedupe path: pre-seed a matching recent lead with a null builder_id.
    const seed: LeadRecord = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      estimateId: ESTIMATE_ID,
      addressKey: 'calgary-123-main-st',
      email: 'homeowner@example.com',
      name: 'Homeowner',
      phone: null,
      timeline: 'exploring',
      marketingConsent: true,
      consentTs: NOW,
      tenantKey: 'acme-builders',
      source: 'embed',
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
    };
    rows.set(seed.id, seed);
    const dedupeStore = {
      ...store,
      findRecentByEmailAndAddress: async () => seed,
    } as unknown as LeadStore;
    const repairService = createLeadService({
      store: dedupeStore,
      estimateStore: fakeEstimateStore(),
      magicLinks: fakeMagicLinkStore(),
      email: fakeEmailService(),
      unsubscribe: fakeUnsubscribe,
      appBaseUrl: APP_BASE_URL,
      dedupWindowDays: 90,
      magicLinkTtlSeconds: 900,
      builderConfigs: fakeBuilderConfigs(),
      builders,
      clock: () => NOW,
    });
    await repairService.submitLead({ ...BASE_BODY, tenantKey: 'acme-builders' });

    expect(rows.get(seed.id)!.builderId).toBe(ACME_BUILDER_ID);
  });

  it('a builder-lookup failure surfaces instead of capturing a portal-invisible lead', async () => {
    const { store, rows } = fakeLeadStore();
    const failingBuilders = {
      ...fakeBuilders(),
      getByTenantKey: async () => {
        throw new Error('connection reset');
      },
    } as unknown as BuilderService;
    const service = createLeadService({
      store,
      estimateStore: fakeEstimateStore(),
      magicLinks: fakeMagicLinkStore(),
      email: fakeEmailService(),
      unsubscribe: fakeUnsubscribe,
      appBaseUrl: APP_BASE_URL,
      dedupWindowDays: 90,
      magicLinkTtlSeconds: 900,
      builderConfigs: fakeBuilderConfigs(),
      builders: failingBuilders,
      clock: () => NOW,
    });

    // The failure stays loud and retryable — no silently builder-less row.
    await expect(
      service.submitLead({ ...BASE_BODY, tenantKey: 'acme-builders' }),
    ).rejects.toThrow('connection reset');
    expect(rows.size).toBe(0);
  });
});
