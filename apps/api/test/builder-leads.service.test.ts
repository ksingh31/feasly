/**
 * Unit tests for the builder-leads service (embed/09).
 *
 * Builder isolation is the critical property:
 * - listLeads returns ONLY leads assigned to the builder (builder_id).
 * - updateStatus on another builder's lead throws 403.
 * - updateStatus on an unassigned lead throws 403.
 * - Inactive builders and unknown tenant keys get 404.
 * - Every real status transition appends lead_status_history.
 *
 * Fakes in-memory: no DB, no network. Tests run under vitest.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createBuilderLeadsService,
  type BuilderLeadsServiceDeps,
} from '../src/services/builder-leads.service';
import type { BuilderService } from '../src/services/builder.service';
import type { LeadStore } from '../src/services/lead.store';
import type { AdminAuditStore } from '../src/services/admin-audit.store';

const ELITE_BUILDER_ID = 'builder-elite';
const OTHER_BUILDER_ID = 'builder-other';

function makeLead(overrides?: {
  readonly id?: string;
  readonly builderId?: string | null;
  readonly tenantKey?: string;
  readonly status?: string;
}) {
  return {
    id: overrides?.id ?? 'lead-1',
    estimateId: 'est-1',
    tenantKey: overrides?.tenantKey ?? 'elite-craft',
    // NB: must check 'in' not ?? — null is a valid override (unassigned).
    builderId:
      overrides && 'builderId' in overrides
        ? overrides.builderId ?? null
        : ELITE_BUILDER_ID,
    addressKey: '123 Main St',
    email: 'homeowner@example.com',
    name: 'Jane Doe',
    phone: null,
    timeline: '3-6 months',
    leadScore: 75,
    status: overrides?.status ?? 'new',
    marketingConsent: true,
    consentTs: new Date(),
    source: 'web',
    quarantined: false,
    quarantineReason: null,
    projectType: 'new-build',
    sandbox: false,
    unsubscribedAt: null,
    contactOptOutAt: null,
    consentUpdatedAt: new Date(),
    nudgeSentAt: null,
    sheetsSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeBuilderRow(overrides?: {
  readonly id?: string;
  readonly tenantKey?: string;
  readonly status?: 'active' | 'inactive';
}) {
  const now = new Date();
  return {
    id: overrides?.id ?? ELITE_BUILDER_ID,
    tenantKey: overrides?.tenantKey ?? 'elite-craft',
    businessName: 'Elite Craft Builders Ltd.',
    displayName: 'Elite Craft Builders',
    email: 'build@elitecraftbuilders.com',
    phone: null,
    logoUrl: null,
    accentColor: '#C9A227',
    allowedOrigins: [],
    plan: null,
    status: overrides?.status ?? ('active' as const),
    settings: {},
    createdAt: now,
    updatedAt: now,
  };
}

function makeDeps() {
  const leads = new Map<string, ReturnType<typeof makeLead>>();
  leads.set('lead-1', makeLead({ id: 'lead-1', builderId: ELITE_BUILDER_ID }));
  leads.set('lead-2', makeLead({ id: 'lead-2', builderId: OTHER_BUILDER_ID, tenantKey: 'other' }));
  leads.set('lead-unassigned', makeLead({ id: 'lead-unassigned', builderId: null }));

  const buildersByTenantKey = new Map<string, ReturnType<typeof makeBuilderRow>>();
  buildersByTenantKey.set(
    'elite-craft',
    makeBuilderRow({ id: ELITE_BUILDER_ID, tenantKey: 'elite-craft' }),
  );
  buildersByTenantKey.set(
    'other',
    makeBuilderRow({ id: OTHER_BUILDER_ID, tenantKey: 'other' }),
  );
  buildersByTenantKey.set(
    'inactive',
    makeBuilderRow({ id: 'builder-inactive', tenantKey: 'inactive', status: 'inactive' }),
  );

  const statusHistory: Array<{
    readonly leadId: string;
    readonly oldStatus: string;
    readonly newStatus: string;
    readonly changedBy: string;
  }> = [];

  const leadStore: LeadStore = {
    findRecentByEmailAndAddress: async () => null,
    listLeads: async () => [],
    listByTenantKey: async ({ tenantKey }) =>
      [...leads.values()].filter((l) => l.tenantKey === tenantKey),
    listByBuilderId: async ({ builderId }) =>
      [...leads.values()].filter((l) => l.builderId === builderId),
    insert: async () => {
      throw new Error('not implemented');
    },
    findById: async (id) => leads.get(id) ?? null,
    findByIdAndBuilderId: async ({ id, builderId }) => {
      const lead = leads.get(id) ?? null;
      return lead && lead.builderId === builderId ? lead : null;
    },
    existsById: async (id) => leads.has(id),
    findByEstimateId: async () => null,
    findNewestEstimateIdByEmailAndAddress: async () => null,
    updateOnRepeat: async () => {
      throw new Error('not implemented');
    },
    updateConsentPreferences: async () => null,
    updateStatus: async ({ id, status }: { id: string; status: string }) => {
      const lead = leads.get(id);
      if (!lead) return null;
      const updated = { ...lead, status, updatedAt: new Date() };
      leads.set(id, updated);
      return updated;
    },
    updateStatusForBuilder: async ({
      id,
      builderId,
      status,
    }: {
      id: string;
      builderId: string;
      status: string;
    }) => {
      const lead = leads.get(id);
      if (!lead || lead.builderId !== builderId) return null;
      const updated = { ...lead, status, updatedAt: new Date() };
      leads.set(id, updated);
      return updated;
    },
    appendStatusHistory: async ({
      leadId,
      oldStatus,
      newStatus,
      changedBy,
    }: {
      leadId: string;
      oldStatus: string | null;
      newStatus: string;
      changedBy?: string;
    }) => {
      statusHistory.push({
        leadId,
        oldStatus: oldStatus ?? 'unknown',
        newStatus,
        changedBy: changedBy ?? 'system',
      });
    },
    getStatusHistory: async () => [],
    appendNote: async () => {},
    getNotes: async () => [],
    setUnsubscribedAt: async () => null,
    findNudgeCandidates: async () => [],
    countNeverSynced: async () => 0,
    findSheetsSyncCandidates: async () => [],
    setSheetsSyncedAt: async () => null,
    setNudgeSentAt: async () => null,
    findAllByEmail: async () => [],
    deleteByEmail: async () => 0,
  };

  const builders = {
    listBuilders: async () => [...buildersByTenantKey.values()],
    getBuilder: async (id: string) => {
      const row = [...buildersByTenantKey.values()].find((b) => b.id === id);
      if (!row) {
        throw Object.assign(new Error('Builder not found.'), { status: 404 });
      }
      return row;
    },
    getByTenantKey: async (tenantKey: string) =>
      buildersByTenantKey.get(tenantKey) ?? null,
    createBuilder: async () => {
      throw new Error('not implemented');
    },
    updateBuilder: async () => {
      throw new Error('not implemented');
    },
    assignLead: async () => ({ ok: true as const }),
  } as unknown as BuilderService;

  const audit: AdminAuditStore = {
    log: vi.fn(async () => {}),
  } as unknown as AdminAuditStore;

  const service = createBuilderLeadsService({ leadStore, audit, builders });

  return { service, leadStore, builders, audit, statusHistory, leads };
}

describe('builder-leads service (embed/09)', () => {
  it('listLeads returns only the builder-assigned leads', async () => {
    const { service } = makeDeps();
    const result = await service.listLeads('elite-craft');
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.id).toBe('lead-1');
  });

  it('listLeads excludes another builder leads and unassigned leads', async () => {
    const { service } = makeDeps();
    const result = await service.listLeads('other');
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.id).toBe('lead-2');
  });

  it('listLeads on unknown tenant key throws 404', async () => {
    const { service } = makeDeps();
    await expect(service.listLeads('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('listLeads on an inactive builder throws 404', async () => {
    const { service } = makeDeps();
    await expect(service.listLeads('inactive')).rejects.toMatchObject({ status: 404 });
  });

  it('listLeads summary counts by status', async () => {
    const { service, leads } = makeDeps();
    leads.set(
      'lead-3',
      makeLead({ id: 'lead-3', builderId: ELITE_BUILDER_ID, status: 'won' }),
    );
    const result = await service.listLeads('elite-craft');
    expect(result.summary.total).toBe(2);
    expect(result.summary.new).toBe(1);
    expect(result.summary.won).toBe(1);
  });

  it('updateStatus transitions a builder-assigned lead status', async () => {
    const { service, leads } = makeDeps();
    const result = await service.updateStatus(
      'lead-1',
      { status: 'contacted' },
      'elite-craft',
      'builder@example.com',
    );
    expect(result.ok).toBe(true);
    expect(leads.get('lead-1')?.status).toBe('contacted');
  });

  it('updateStatus on another builder lead throws 403 and audits (auth/04 AC2)', async () => {
    // Cross-tenant probing: a valid session for tenant elite-craft forges
    // a lead id belonging to another builder. Expect a generic 403 and an
    // audit row — the probe must not reveal anything about the lead.
    const { service, audit } = makeDeps();
    const err = await service
      .updateStatus(
        'lead-2',
        { status: 'won' },
        'elite-craft',
        'builder@example.com',
      )
      .catch((e) => e);
    expect(err).toMatchObject({ status: 403 });
    expect(String(err.message ?? '')).not.toContain('lead-2');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorEmail: 'builder@example.com',
        action: 'builder_leads_cross_builder_denied',
      }),
    );
  });

  it('updateStatus on an unassigned lead throws 403', async () => {
    const { service } = makeDeps();
    await expect(
      service.updateStatus(
        'lead-unassigned',
        { status: 'contacted' },
        'elite-craft',
        'builder@example.com',
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('updateStatus on missing lead throws 404', async () => {
    const { service } = makeDeps();
    await expect(
      service.updateStatus(
        'missing',
        { status: 'won' },
        'elite-craft',
        'builder@example.com',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('updateStatus appends lead_status_history on real transition', async () => {
    const { service, statusHistory } = makeDeps();
    await service.updateStatus(
      'lead-1',
      { status: 'quoted' },
      'elite-craft',
      'builder@example.com',
    );
    expect(statusHistory).toHaveLength(1);
    expect(statusHistory[0]).toMatchObject({
      leadId: 'lead-1',
      oldStatus: 'new',
      newStatus: 'quoted',
      changedBy: 'builder@example.com',
    });
  });

  it('updateStatus with same status does NOT append history', async () => {
    const { service, statusHistory } = makeDeps();
    await service.updateStatus(
      'lead-1',
      { status: 'new' },
      'elite-craft',
      'builder@example.com',
    );
    expect(statusHistory).toHaveLength(0);
  });

  it('updateStatus rejects invalid status with 400', async () => {
    const { service } = makeDeps();
    await expect(
      service.updateStatus(
        'lead-1',
        { status: 'bogus' },
        'elite-craft',
        'builder@example.com',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('builder-leads won → billing charge path (billing/01)', () => {
  function makeBillingDeps(billingResult?: {
    readonly billed: boolean;
    readonly reason?: string;
  }) {
    const base = makeDeps();
    const recordBillableEvent = vi.fn(async () => ({
      billed: false,
      reason: 'awaiting_contract_details',
      ...billingResult,
    }));
    const billingHook = { recordBillableEvent };
    const service = createBuilderLeadsService({
      leadStore: base.leadStore,
      audit: base.audit,
      builders: base.builders,
      billingHook: billingHook as never,
    });
    return { ...base, service, recordBillableEvent };
  }

  it('won with contract details runs the billing hook and returns its result', async () => {
    const { service, recordBillableEvent, leads } = makeBillingDeps({
      billed: true,
      reason: undefined,
    });
    const result = await service.updateStatus(
      'lead-1',
      {
        status: 'won',
        contractValueCents: 50_000_000,
        contractSignedAt: '2026-09-20T10:00:00.000Z',
      },
      'elite-craft',
      'builder@example.com',
    );

    expect(recordBillableEvent).toHaveBeenCalledTimes(1);
    expect(recordBillableEvent).toHaveBeenCalledWith(
      'elite-craft',
      'lead_won',
      expect.objectContaining({
        leadId: 'lead-1',
        contractValueCents: 50_000_000,
        contractSignedAt: new Date('2026-09-20T10:00:00.000Z'),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.billing).toMatchObject({ billed: true });
    // The pipeline status still transitions.
    expect(leads.get('lead-1')?.status).toBe('won');
  });

  it('won without contract details still calls the hook (parked invoice)', async () => {
    const { service, recordBillableEvent } = makeBillingDeps();
    const result = await service.updateStatus(
      'lead-1',
      { status: 'won' },
      'elite-craft',
      'builder@example.com',
    );

    expect(recordBillableEvent).toHaveBeenCalledTimes(1);
    expect(recordBillableEvent).toHaveBeenCalledWith(
      'elite-craft',
      'lead_won',
      expect.objectContaining({ leadId: 'lead-1' }),
    );
    expect(result.billing).toMatchObject({
      billed: false,
      reason: 'awaiting_contract_details',
    });
  });

  it('non-won transitions never call the billing hook', async () => {
    const { service, recordBillableEvent } = makeBillingDeps();
    await service.updateStatus(
      'lead-1',
      { status: 'quoted' },
      'elite-craft',
      'builder@example.com',
    );
    expect(recordBillableEvent).not.toHaveBeenCalled();
  });

  it('already-won lead does not re-run the hook', async () => {
    const { service, recordBillableEvent, leads } = makeBillingDeps();
    leads.set('lead-1', { ...leads.get('lead-1')!, status: 'won' });
    const result = await service.updateStatus(
      'lead-1',
      { status: 'won' },
      'elite-craft',
      'builder@example.com',
    );
    expect(recordBillableEvent).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.billing).toBeUndefined();
  });

  it('contract details with a non-won status are rejected with 400', async () => {
    const { service, recordBillableEvent } = makeBillingDeps();
    await expect(
      service.updateStatus(
        'lead-1',
        { status: 'quoted', contractValueCents: 50_000_000 },
        'elite-craft',
        'builder@example.com',
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(recordBillableEvent).not.toHaveBeenCalled();
  });

  it('partial contract details (missing signed date) are rejected with 400', async () => {
    const { service, recordBillableEvent } = makeBillingDeps();
    await expect(
      service.updateStatus(
        'lead-1',
        { status: 'won', contractValueCents: 50_000_000 },
        'elite-craft',
        'builder@example.com',
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(recordBillableEvent).not.toHaveBeenCalled();
  });

  it('a billing failure leaves the pipeline status untouched', async () => {
    const base = makeDeps();
    const billingHook = {
      recordBillableEvent: vi.fn(async () => {
        throw Object.assign(new Error('billing exploded'), { status: 422 });
      }),
    };
    const service = createBuilderLeadsService({
      leadStore: base.leadStore,
      audit: base.audit,
      builders: base.builders,
      billingHook: billingHook as never,
    });

    await expect(
      service.updateStatus(
        'lead-1',
        {
          status: 'won',
          contractValueCents: 50_000_000,
          contractSignedAt: '2026-09-20T10:00:00.000Z',
        },
        'elite-craft',
        'builder@example.com',
      ),
    ).rejects.toThrow('billing exploded');
    expect(base.leads.get('lead-1')?.status).toBe('new');
  });

  it('works without a billing hook (tests that do not cover billing)', async () => {
    const { service } = makeDeps();
    const result = await service.updateStatus(
      'lead-1',
      { status: 'won' },
      'elite-craft',
      'builder@example.com',
    );
    expect(result).toEqual({ ok: true });
  });
});
