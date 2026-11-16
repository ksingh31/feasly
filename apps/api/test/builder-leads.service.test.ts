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
import type { UserStore } from '../src/services/user.service';
import { ACCEPTED_AGREEMENTS, blockedAgreements } from './helpers/agreement-gate.fake';
import type { AgreementGate } from '../src/services/builder-agreement.service';

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
      expectedStatus,
      status,
    }: {
      id: string;
      builderId: string;
      expectedStatus: string;
      status: string;
    }) => {
      // Mirrors the SQL compare-and-set (#620): WHERE id AND builder_id AND status.
      const lead = leads.get(id);
      if (!lead || lead.builderId !== builderId || lead.status !== expectedStatus) return null;
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

  const service = createBuilderLeadsService({ agreements: ACCEPTED_AGREEMENTS, leadStore, audit, builders });

  return { service, leadStore, builders, audit, statusHistory, leads };
}

describe('builder-leads service (embed/09)', () => {
  it('listLeads returns only the builder-assigned leads', async () => {    const { service } = makeDeps();
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

  it('two concurrent identical transitions append ONE history row (#620)', async () => {
    const { service, statusHistory, leads } = makeDeps();
    const results = await Promise.all([
      service.updateStatus('lead-1', { status: 'quoted' }, 'elite-craft', 'a@example.com'),
      service.updateStatus('lead-1', { status: 'quoted' }, 'elite-craft', 'b@example.com'),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(leads.get('lead-1')?.status).toBe('quoted');
    expect(statusHistory).toHaveLength(1);
    expect(statusHistory[0]).toMatchObject({ oldStatus: 'new', newStatus: 'quoted' });
  });

  it('losing the race to the same transition succeeds without a history row (#620)', async () => {
    const { service, statusHistory, leads, leadStore } = makeDeps();
    // The read sees 'new', but another request already wrote 'contacted'.
    const stale = leads.get('lead-1')!;
    leads.set('lead-1', { ...stale, status: 'contacted' });
    const realFind = leadStore.findByIdAndBuilderId;
    leadStore.findByIdAndBuilderId = vi
      .fn(realFind)
      .mockResolvedValueOnce(stale);
    const result = await service.updateStatus(
      'lead-1',
      { status: 'contacted' },
      'elite-craft',
      'builder@example.com',
    );
    expect(result.ok).toBe(true);
    expect(statusHistory).toHaveLength(0);
  });

  it('losing the race to a different transition throws 409 CONFLICT and writes nothing (#620)', async () => {
    const { service, statusHistory, leads, leadStore } = makeDeps();
    const stale = leads.get('lead-1')!;
    leads.set('lead-1', { ...stale, status: 'lost' });
    const realFind = leadStore.findByIdAndBuilderId;
    leadStore.findByIdAndBuilderId = vi
      .fn(realFind)
      .mockResolvedValueOnce(stale);
    await expect(
      service.updateStatus('lead-1', { status: 'quoted' }, 'elite-craft', 'builder@example.com'),
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(leads.get('lead-1')?.status).toBe('lost');
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
  function makeBillingDeps(
    billingResult?: {
      readonly billed: boolean;
      readonly reason?: string;
    },
    agreements: AgreementGate = ACCEPTED_AGREEMENTS,
  ) {
    const base = makeDeps();
    const recordBillableEvent = vi.fn(async () => ({
      billed: false,
      reason: 'awaiting_contract_details',
      ...billingResult,
    }));
    const billingHook = { recordBillableEvent };
    const service = createBuilderLeadsService({
      agreements,
      leadStore: base.leadStore,
      audit: base.audit,
      builders: base.builders,
      billingHook: billingHook as never,
    });
    return { ...base, service, recordBillableEvent };
  }

  it('won WITH contract details 409s AGREEMENT_REQUIRED without a current acceptance (#722) — no billing, no status change', async () => {
    const { service, recordBillableEvent, leads } = makeBillingDeps(
      { billed: true },
      blockedAgreements(),
    );
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
    ).rejects.toMatchObject({ status: 409, code: 'AGREEMENT_REQUIRED' });
    expect(recordBillableEvent).not.toHaveBeenCalled();
    expect(leads.get('lead-1')?.status).not.toBe('won');
  });

  it('won WITHOUT contract details is not gated by the agreement (#722)', async () => {
    const { service, leads } = makeBillingDeps(undefined, blockedAgreements());
    const result = await service.updateStatus(
      'lead-1',
      { status: 'won' },
      'elite-craft',
      'builder@example.com',
    );
    expect(result.ok).toBe(true);
    expect(leads.get('lead-1')?.status).toBe('won');
  });

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

  it('an invoiced won that loses the race to a different status still lands on won (#620)', async () => {
    const { service, recordBillableEvent, leads, statusHistory } = makeBillingDeps({
      billed: true,
      reason: undefined,
    });
    // The read sees 'new'; another request moves the lead to 'lost' while
    // billing runs — after the invoice exists.
    recordBillableEvent.mockImplementationOnce(async () => {
      const lead = leads.get('lead-1')!;
      leads.set('lead-1', { ...lead, status: 'lost' });
      return { billed: true, reason: undefined } as never;
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
    expect(result.ok).toBe(true);
    expect(result.billing).toMatchObject({ billed: true });
    expect(leads.get('lead-1')?.status).toBe('won');
    expect(statusHistory).toEqual([
      expect.objectContaining({ oldStatus: 'lost', newStatus: 'won' }),
    ]);
  });

  it('an un-invoiced won that loses the race to a different status still gets 409 (#620)', async () => {
    const { service, recordBillableEvent, leads, statusHistory } = makeBillingDeps();
    recordBillableEvent.mockImplementationOnce(async () => {
      const lead = leads.get('lead-1')!;
      leads.set('lead-1', { ...lead, status: 'lost' });
      return { billed: false, reason: 'awaiting_contract_details' } as never;
    });
    await expect(
      service.updateStatus('lead-1', { status: 'won' }, 'elite-craft', 'builder@example.com'),
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(leads.get('lead-1')?.status).toBe('lost');
    expect(statusHistory).toHaveLength(0);
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
      agreements: ACCEPTED_AGREEMENTS,
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

describe('builder-leads invoice summaries (record-contract flow redesign)', () => {
  function makeServiceWithSummaries(
    summaries: ReadonlyArray<{
      readonly id: string;
      readonly leadId: string;
      readonly invoiceNumber: string;
      readonly contractValueCents: number;
      readonly commissionCents: number;
      readonly currency: string;
      readonly status: string;
      readonly reviewDueAt: Date | null;
      readonly paymentMethod: string;
    }>,
  ) {
    const base = makeDeps();
    const service = createBuilderLeadsService({
      agreements: ACCEPTED_AGREEMENTS,
      leadStore: base.leadStore,
      audit: base.audit,
      builders: base.builders,
      invoiceSummaries: {
        findByTenantKey: async (tenantKey: string) =>
          tenantKey === 'elite-craft' ? summaries : [],
        hasInvoiceForLead: async ({ leadId, tenantKey }) =>
          tenantKey === 'elite-craft' &&
          summaries.some((s) => s.leadId === leadId),
      },
    });
    return service;
  }

  it('marks leads with invoices and attaches the summary', async () => {
    const service = makeServiceWithSummaries([
      {
        id: 'inv-1',
        leadId: 'lead-1',
        invoiceNumber: 'INV-0042',
        contractValueCents: 50000000,
        commissionCents: 500000,
        currency: 'CAD',
        status: 'in_review',
        reviewDueAt: new Date('2026-10-06T00:00:00.000Z'),
        paymentMethod: 'cheque',
      },
    ]);
    const result = await service.listLeads('elite-craft');
    expect(result.leads).toHaveLength(1);
    const item = result.leads[0];
    expect(item?.hasInvoice).toBe(true);
    expect(item?.invoiceSummary).toEqual({
      id: 'inv-1',
      invoiceNumber: 'INV-0042',
      contractValueCents: 50000000,
      commissionCents: 500000,
      status: 'in_review',
      reviewDueAt: '2026-10-06T00:00:00.000Z',
      paymentMethod: 'cheque',
    });
  });

  it('marks leads without invoices as not recorded', async () => {
    const service = makeServiceWithSummaries([]);
    const result = await service.listLeads('elite-craft');
    expect(result.leads[0]?.hasInvoice).toBe(false);
    expect(result.leads[0]?.invoiceSummary).toBeNull();
  });

  it('works without the invoice-summaries dep (older call sites)', async () => {
    const { service } = makeDeps();
    const result = await service.listLeads('elite-craft');
    expect(result.leads[0]?.hasInvoice).toBe(false);
    expect(result.leads[0]?.invoiceSummary).toBeNull();
  });
});

describe('builder-leads status lock (2026-09-29)', () => {
  function makeServiceWithInvoice(leadId: string) {
    const base = makeDeps();
    const summaries = [
      {
        id: 'inv-1',
        leadId,
        invoiceNumber: 'INV-0042',
        contractValueCents: 50000000,
        commissionCents: 500000,
        currency: 'CAD',
        status: 'in_review',
        reviewDueAt: new Date('2026-10-06T00:00:00.000Z'),
        paymentMethod: 'card',
      },
    ];
    const service = createBuilderLeadsService({
      agreements: ACCEPTED_AGREEMENTS,
      leadStore: base.leadStore,
      audit: base.audit,
      builders: base.builders,
      invoiceSummaries: {
        findByTenantKey: async (tenantKey: string) =>
          tenantKey === 'elite-craft' ? summaries : [],
        hasInvoiceForLead: async ({ leadId: checkId, tenantKey }) =>
          tenantKey === 'elite-craft' &&
          summaries.some((s) => s.leadId === checkId),
      },
    });
    return { service, leads: base.leads, statusHistory: base.statusHistory };
  }

  it('rejects a status change on a recorded lead with 409 LEAD_STATUS_LOCKED', async () => {
    const { service, leads, statusHistory } = makeServiceWithInvoice('lead-1');
    const before = leads.get('lead-1')?.status;
    expect(before).toBe('new');

    const err = await service
      .updateStatus('lead-1', { status: 'contacted' }, 'elite-craft', 'builder@example.com')
      .then(
        () => null,
        (e: unknown) => e as { status: number; code: string; message: string },
      );
    expect(err).not.toBeNull();
    expect(err?.status).toBe(409);
    expect(err?.code).toBe('LEAD_STATUS_LOCKED');

    // No side effects: status and history untouched.
    expect(leads.get('lead-1')?.status).toBe('new');
    expect(statusHistory).toHaveLength(0);
  });

  it('rejects won→new on a recorded lead (never flippable back)', async () => {
    const { service, leads } = makeServiceWithInvoice('lead-1');
    leads.set('lead-1', { ...leads.get('lead-1')!, status: 'won' });

    const err = await service
      .updateStatus('lead-1', { status: 'new' }, 'elite-craft', 'builder@example.com')
      .then(
        () => null,
        (e: unknown) => e as { status: number; code: string },
      );
    expect(err?.status).toBe(409);
    expect(err?.code).toBe('LEAD_STATUS_LOCKED');
    expect(leads.get('lead-1')?.status).toBe('won');
  });

  it('allows a no-op same-status update on a recorded lead', async () => {
    const { service, leads } = makeServiceWithInvoice('lead-1');
    const result = await service.updateStatus(
      'lead-1',
      { status: 'new' },
      'elite-craft',
      'builder@example.com',
    );
    expect(result.ok).toBe(true);
    expect(leads.get('lead-1')?.status).toBe('new');
  });

  it('still transitions unrecorded leads when the dep is wired', async () => {
    const { service, leads } = makeServiceWithInvoice('lead-other');
    const result = await service.updateStatus(
      'lead-1',
      { status: 'contacted' },
      'elite-craft',
      'builder@example.com',
    );
    expect(result.ok).toBe(true);
    expect(leads.get('lead-1')?.status).toBe('contacted');
  });
});

describe('builder-leads comment summaries (notes section redesign)', () => {
  function makeServiceWithComments(
    summaries: ReadonlyMap<string, { count: number; latest: { authorId: string; authorKind: 'builder' | 'admin'; body: string; createdAt: Date } | null }>,
    userNames: ReadonlyMap<string, string>,
  ) {
    const base = makeDeps();
    const calls: Array<{
      readonly entityType: string;
      readonly entityIds: ReadonlyArray<string>;
      readonly includeAdminOnly: boolean;
    }> = [];
    const service = createBuilderLeadsService({
      agreements: ACCEPTED_AGREEMENTS,
      leadStore: base.leadStore,
      audit: base.audit,
      builders: base.builders,
      commentSummaries: {
        summariesByEntity: async ({ entityType, entityIds, includeAdminOnly }) => {
          calls.push({ entityType, entityIds, includeAdminOnly });
          return new Map(
            [...summaries].filter(([entityId]) => entityIds.includes(entityId)),
          );
        },
      },
      users: {
        findById: async (id: string) =>
          userNames.has(id) ? { id, name: userNames.get(id)! } : null,
      } as unknown as Pick<UserStore, 'findById'>,
    });
    return { service, calls };
  }

  const LATEST = {
    authorId: 'user-1',
    authorKind: 'builder' as const,
    body: 'Called — no answer.',
    createdAt: new Date('2026-09-28T10:00:00.000Z'),
  };

  it('attaches count + latest preview with the resolved author name', async () => {
    const { service, calls } = makeServiceWithComments(
      new Map([['lead-1', { count: 2, latest: LATEST }]]),
      new Map([['user-1', 'Mya Builder']]),
    );
    const result = await service.listLeads('elite-craft');
    const item = result.leads[0];
    expect(item?.commentCount).toBe(2);
    expect(item?.latestComment).toEqual({
      body: 'Called — no answer.',
      authorDisplayName: 'Mya Builder',
      authorKind: 'builder',
      createdAt: '2026-09-28T10:00:00.000Z',
    });
    // One store call, builder-visible rows only.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.entityType).toBe('lead');
    expect(calls[0]?.includeAdminOnly).toBe(false);
    expect(calls[0]?.entityIds).toContain('lead-1');
  });

  it('defaults to count 0 and a null preview when the lead has no summary', async () => {
    const { service } = makeServiceWithComments(
      new Map(),
      new Map(),
    );
    const result = await service.listLeads('elite-craft');
    expect(result.leads[0]?.commentCount).toBe(0);
    expect(result.leads[0]?.latestComment).toBeNull();
  });

  it('falls back to Unknown when the author has no user row', async () => {
    const { service } = makeServiceWithComments(
      new Map([['lead-1', { count: 1, latest: LATEST }]]),
      new Map(),
    );
    const result = await service.listLeads('elite-craft');
    expect(result.leads[0]?.latestComment?.authorDisplayName).toBe('Unknown');
  });

  it('works without the comment deps (older call sites)', async () => {
    const { service } = makeDeps();
    const result = await service.listLeads('elite-craft');
    expect(result.leads[0]?.commentCount).toBe(0);
    expect(result.leads[0]?.latestComment).toBeNull();
  });
});

describe('builder-leads markWon → needs recording (#530)', () => {
  type Sent = { readonly to: string; readonly leadId: string; readonly markedBy: string };

  function makeMarkWonService(opts?: {
    readonly adminEmails?: readonly string[];
    readonly adminLookupFails?: boolean;
    readonly fallbackAdminInbox?: string;
    readonly emailFails?: boolean;
    readonly recordedLeadIds?: readonly string[];
    readonly withBillingHook?: boolean;
  }) {
    const base = makeDeps();
    const sent: Sent[] = [];
    const recorded = new Set(opts?.recordedLeadIds ?? []);
    const hookCalls: Array<{ readonly detail: Record<string, unknown> }> = [];
    const service = createBuilderLeadsService({
      agreements: ACCEPTED_AGREEMENTS,
      leadStore: base.leadStore,
      audit: base.audit,
      builders: base.builders,
      invoiceSummaries: {
        findByTenantKey: async () => [],
        hasInvoiceForLead: async ({ leadId }) => recorded.has(leadId),
      },
      memberships: {
        listActiveOrgAdminEmails: async (builderId: string) => {
          if (opts?.adminLookupFails) throw new Error('db down');
          return builderId === ELITE_BUILDER_ID
            ? [...(opts?.adminEmails ?? ['owner@elite.example'])]
            : [];
        },
      },
      email: {
        sendContractNeedsRecording: async (input) => {
          if (opts?.emailFails) throw new Error('provider down');
          sent.push({ to: input.to, leadId: input.leadId, markedBy: input.markedBy });
          return { sent: true as const, provider: 'log' as const };
        },
      },
      fallbackAdminInbox: opts?.fallbackAdminInbox,
      billingHook: opts?.withBillingHook
        ? ({
            recordBillableEvent: async (
              _tenantKey: string,
              _type: string,
              detail: Record<string, unknown>,
            ) => {
              hookCalls.push({ detail });
              return { billed: false as const, reason: 'contract_pending' };
            },
          } as unknown as NonNullable<BuilderLeadsServiceDeps['billingHook']>)
        : undefined,
    });
    return { ...base, service, sent, hookCalls };
  }

  it('a member marks a lead won: status, history, audit and needsRecording', async () => {
    const { service, leads, statusHistory, audit } = makeMarkWonService();
    const result = await service.markWon('lead-1', 'elite-craft', 'member@elite.example');

    expect(result).toEqual({
      ok: true,
      status: 'won',
      needsRecording: true,
      changed: true,
      adminsNotified: 1,
    });
    expect(leads.get('lead-1')?.status).toBe('won');
    expect(statusHistory).toEqual([
      {
        leadId: 'lead-1',
        oldStatus: 'new',
        newStatus: 'won',
        changedBy: 'member@elite.example',
      },
    ]);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorEmail: 'member@elite.example',
        action: 'builder_leads_marked_won',
      }),
    );

    // The admin "Needs recording" item: flag on the lead + summary count.
    const list = await service.listLeads('elite-craft');
    expect(list.leads[0]?.needsRecording).toBe(true);
    expect(list.summary.needsRecording).toBe(1);
  });

  it('emails every org admin a "Needs recording" notice', async () => {
    const { service, sent } = makeMarkWonService({
      adminEmails: ['owner@elite.example', 'ops@elite.example'],
    });
    await service.markWon('lead-1', 'elite-craft', 'member@elite.example');
    expect(sent.map((s) => s.to).sort()).toEqual([
      'ops@elite.example',
      'owner@elite.example',
    ]);
    expect(sent.every((s) => s.leadId === 'lead-1')).toBe(true);
    expect(sent.every((s) => s.markedBy === 'member@elite.example')).toBe(true);
  });

  it('never emails the actor, even when they are an admin', async () => {
    const { service, sent } = makeMarkWonService({
      adminEmails: ['Owner@Elite.example', 'ops@elite.example'],
      fallbackAdminInbox: 'ops@feasly.example',
    });
    const result = await service.markWon('lead-1', 'elite-craft', 'owner@elite.example');
    expect(sent.map((s) => s.to)).toEqual(['ops@elite.example']);
    expect(result.adminsNotified).toBe(1);
  });

  it('does not fall back to Feasly ops when the actor is the sole admin', async () => {
    const { service, sent } = makeMarkWonService({
      adminEmails: ['owner@elite.example'],
      fallbackAdminInbox: 'ops@feasly.example',
    });
    const result = await service.markWon('lead-1', 'elite-craft', 'owner@elite.example');
    expect(sent).toEqual([]);
    expect(result.adminsNotified).toBe(0);
  });

  it('falls back to the Feasly ops inbox when the org has no admin', async () => {
    const { service, sent } = makeMarkWonService({
      adminEmails: [],
      fallbackAdminInbox: 'ops@feasly.example',
    });
    const result = await service.markWon('lead-1', 'elite-craft', 'member@elite.example');
    expect(sent.map((s) => s.to)).toEqual(['ops@feasly.example']);
    expect(result.adminsNotified).toBe(1);
  });

  it('an email failure never fails the request (needsRecording is the durable item)', async () => {
    const { service, leads } = makeMarkWonService({ emailFails: true });
    const result = await service.markWon('lead-1', 'elite-craft', 'member@elite.example');
    expect(result.changed).toBe(true);
    expect(result.adminsNotified).toBe(0);
    expect(leads.get('lead-1')?.status).toBe('won');
  });

  it('an admin-lookup failure is not "no admin": no ops fallback, warns, still marks won', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, sent, leads } = makeMarkWonService({
      adminLookupFails: true,
      fallbackAdminInbox: 'ops@feasly.example',
    });
    const result = await service.markWon('lead-1', 'elite-craft', 'member@elite.example');
    expect(result.changed).toBe(true);
    expect(result.adminsNotified).toBe(0);
    expect(leads.get('lead-1')?.status).toBe('won');
    // The lead's name/address never goes to Feasly ops on a lookup blip.
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('org admin lookup failed'));
    // The warning carries ids only — no lead PII.
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('member@elite.example');
    warn.mockRestore();
  });

  it('runs the won billing path WITHOUT contract details (no invoice)', async () => {
    const { service, hookCalls } = makeMarkWonService({ withBillingHook: true });
    await service.markWon('lead-1', 'elite-craft', 'member@elite.example');
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]?.detail['contractValueCents']).toBeUndefined();
    expect(hookCalls[0]?.detail['contractSignedAt']).toBeUndefined();
  });

  it('already-won lead: idempotent, no write and no re-notify', async () => {
    const { service, leads, sent, statusHistory } = makeMarkWonService();
    leads.set('lead-1', makeLead({ id: 'lead-1', status: 'won' }));
    const result = await service.markWon('lead-1', 'elite-craft', 'member@elite.example');
    expect(result).toEqual({
      ok: true,
      status: 'won',
      needsRecording: true,
      changed: false,
      adminsNotified: 0,
    });
    expect(sent).toEqual([]);
    expect(statusHistory).toEqual([]);
  });

  it('two concurrent "Mark won" clicks notify admins ONCE (#620)', async () => {
    const { service, leads, sent, statusHistory } = makeMarkWonService();
    const results = await Promise.all([
      service.markWon('lead-1', 'elite-craft', 'member@elite.example'),
      service.markWon('lead-1', 'elite-craft', 'other@elite.example'),
    ]);
    expect(leads.get('lead-1')?.status).toBe('won');
    expect(statusHistory).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    const loser = results.find((r) => !r.changed);
    expect(loser).toEqual({
      ok: true,
      status: 'won',
      needsRecording: true,
      changed: false,
      adminsNotified: 0,
    });
  });

  it('a lead with a recorded contract is rejected with 409 LEAD_STATUS_LOCKED', async () => {
    const { service, leads, sent } = makeMarkWonService({ recordedLeadIds: ['lead-1'] });
    await expect(
      service.markWon('lead-1', 'elite-craft', 'member@elite.example'),
    ).rejects.toMatchObject({ status: 409, code: 'LEAD_STATUS_LOCKED' });
    expect(leads.get('lead-1')?.status).toBe('new');
    expect(sent).toEqual([]);
  });

  it("another builder's lead is 403 (audit-logged), never notified", async () => {
    const { service, sent, audit } = makeMarkWonService();
    await expect(
      service.markWon('lead-2', 'elite-craft', 'member@elite.example'),
    ).rejects.toMatchObject({ status: 403 });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'builder_leads_cross_builder_denied' }),
    );
    expect(sent).toEqual([]);
  });

  it('an unknown lead is 404; an unknown tenant is 404', async () => {
    const { service } = makeMarkWonService();
    await expect(
      service.markWon('nope', 'elite-craft', 'member@elite.example'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.markWon('lead-1', 'nope', 'member@elite.example'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('listLeads: needsRecording is false for won leads with a recorded contract', async () => {
    const base = makeDeps();
    base.leads.set('lead-1', makeLead({ id: 'lead-1', status: 'won' }));
    const service = createBuilderLeadsService({
      agreements: ACCEPTED_AGREEMENTS,
      leadStore: base.leadStore,
      audit: base.audit,
      builders: base.builders,
      invoiceSummaries: {
        findByTenantKey: async () => [
          {
            id: 'inv-1',
            leadId: 'lead-1',
            invoiceNumber: 'INV-0042',
            contractValueCents: 50000000,
            commissionCents: 500000,
            status: 'in_review',
            reviewDueAt: null,
            paymentMethod: 'card',
            currency: 'CAD',
          },
        ],
        hasInvoiceForLead: async () => true,
      },
    });
    const list = await service.listLeads('elite-craft');
    expect(list.leads[0]?.needsRecording).toBe(false);
    expect(list.summary.needsRecording).toBe(0);
  });
});

describe('builder-leads "Needs you" feed (issue #526)', () => {
  const NOW = new Date('2026-11-15T12:00:00.000Z');
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

  function lead(
    id: string,
    status: string,
    opts: {
      readonly score?: number;
      readonly createdAt?: Date;
      readonly updatedAt?: Date;
      readonly builderId?: string;
    } = {},
  ) {
    const createdAt = opts.createdAt ?? daysAgo(30);
    return {
      ...makeLead({ id, status, builderId: opts.builderId ?? ELITE_BUILDER_ID }),
      leadScore: opts.score ?? 50,
      createdAt,
      updatedAt: opts.updatedAt ?? createdAt,
    };
  }

  function makeNeedsYouService(opts: {
    readonly leads: ReadonlyArray<ReturnType<typeof lead>>;
    readonly history?: Readonly<Record<string, Date>>;
    readonly invoicedLeadIds?: readonly string[];
    readonly withStatusChanges?: boolean;
    readonly withConfig?: boolean;
  }) {
    const base = makeDeps();
    base.leads.clear();
    for (const l of opts.leads) base.leads.set(l.id, l);
    const listSpy = vi.spyOn(base.leadStore, 'listByBuilderId');
    const historyLookup = vi.fn(async (ids: readonly string[]) => {
      const out = new Map<string, Date>();
      for (const id of ids) {
        const at = opts.history?.[id];
        if (at) out.set(id, at);
      }
      return out;
    });
    const invoiced = opts.invoicedLeadIds ?? [];
    const service = createBuilderLeadsService({
      agreements: ACCEPTED_AGREEMENTS,
      leadStore: base.leadStore,
      audit: base.audit,
      builders: base.builders,
      clock: () => NOW,
      invoiceSummaries: {
        findByTenantKey: async (tenantKey: string) =>
          tenantKey === 'elite-craft'
            ? invoiced.map((leadId, i) => ({
                id: `inv-${i}`,
                leadId,
                invoiceNumber: `INV-${i}`,
                contractValueCents: 1,
                commissionCents: 1,
                currency: 'CAD',
                status: 'in_review',
                reviewDueAt: null,
                paymentMethod: 'card',
              }))
            : [],
        hasInvoiceForLead: async () => false,
      },
      ...(opts.withStatusChanges === false
        ? {}
        : { statusChanges: { latestStatusChangeByLeadIds: historyLookup } }),
      ...(opts.withConfig === false
        ? {}
        : { needsYou: { staleAfterDays: 7, scanLimit: 250 } }),
    });
    return { service, listSpy, historyLookup };
  }

  it('groups uncontacted, stale and won-without-contract leads server-side', async () => {
    const { service } = makeNeedsYouService({
      leads: [
        lead('new-1', 'new', { createdAt: daysAgo(0.1) }),
        lead('contacted-stale', 'contacted'),
        lead('contacted-fresh', 'contacted'),
        lead('quoted-never-changed', 'quoted', { createdAt: daysAgo(8) }),
        lead('won-open', 'won'),
        lead('won-recorded', 'won'),
        lead('lost-1', 'lost'),
      ],
      history: {
        'contacted-stale': daysAgo(10),
        'contacted-fresh': daysAgo(2),
        'won-open': daysAgo(3),
        'won-recorded': daysAgo(3),
      },
      invoicedLeadIds: ['won-recorded'],
    });

    const result = await service.getNeedsYou('elite-craft');

    expect(result.uncontacted.map((l) => l.id)).toEqual(['new-1']);
    expect(result.stale.map((l) => l.id).sort()).toEqual([
      'contacted-stale',
      'quoted-never-changed',
    ]);
    expect(result.wonWithoutContract.map((l) => l.id)).toEqual(['won-open']);
    expect(result.staleAfterDays).toBe(7);
    expect(result.counts).toEqual({
      total: 7,
      new: 1,
      contacted: 2,
      quoted: 1,
      won: 2,
      lost: 1,
    });
  });

  it('sorts each group by score (desc) then age (oldest first)', async () => {
    const { service } = makeNeedsYouService({
      leads: [
        lead('low-old', 'new', { score: 40, createdAt: daysAgo(5) }),
        lead('high-young', 'new', { score: 90, createdAt: daysAgo(1) }),
        lead('high-old', 'new', { score: 90, createdAt: daysAgo(3) }),
        lead('mid', 'new', { score: 60, createdAt: daysAgo(0.5) }),
        lead('stale-a', 'contacted', { score: 70 }),
        lead('stale-b', 'quoted', { score: 70 }),
        lead('stale-c', 'contacted', { score: 80 }),
      ],
      history: {
        'stale-a': daysAgo(9),
        'stale-b': daysAgo(20),
        'stale-c': daysAgo(8),
      },
    });

    const result = await service.getNeedsYou('elite-craft');

    expect(result.uncontacted.map((l) => l.id)).toEqual([
      'high-old',
      'high-young',
      'mid',
      'low-old',
    ]);
    expect(result.stale.map((l) => l.id)).toEqual(['stale-c', 'stale-b', 'stale-a']);
  });

  it('sets waitingSince from createdAt (uncontacted) and the status change (stale/won)', async () => {
    const { service } = makeNeedsYouService({
      leads: [
        lead('new-1', 'new', { createdAt: daysAgo(1) }),
        lead('stale-1', 'contacted', { createdAt: daysAgo(30) }),
        lead('won-1', 'won', { createdAt: daysAgo(30) }),
      ],
      history: { 'stale-1': daysAgo(10), 'won-1': daysAgo(2) },
    });

    const result = await service.getNeedsYou('elite-craft');

    expect(result.uncontacted[0]).toMatchObject({
      waitingSince: daysAgo(1).toISOString(),
      createdAt: daysAgo(1).toISOString(),
    });
    expect(result.stale[0]).toMatchObject({
      waitingSince: daysAgo(10).toISOString(),
      statusChangedAt: daysAgo(10).toISOString(),
      createdAt: daysAgo(30).toISOString(),
    });
    expect(result.wonWithoutContract[0]?.waitingSince).toBe(daysAgo(2).toISOString());
  });

  it('treats exactly staleAfterDays as stale and one minute less as fresh', async () => {
    const { service } = makeNeedsYouService({
      leads: [
        lead('edge', 'contacted'),
        lead('almost', 'contacted'),
      ],
      history: {
        edge: daysAgo(7),
        almost: new Date(daysAgo(7).getTime() + 60_000),
      },
    });

    const result = await service.getNeedsYou('elite-craft');

    expect(result.stale.map((l) => l.id)).toEqual(['edge']);
  });

  it('ignores updated_at noise when the status history says the lead is stale', async () => {
    // A consent/nudge write bumps updated_at; the status itself is old.
    const { service } = makeNeedsYouService({
      leads: [lead('stale-1', 'contacted', { updatedAt: daysAgo(0.1) })],
      history: { 'stale-1': daysAgo(12) },
    });

    const result = await service.getNeedsYou('elite-craft');

    expect(result.stale.map((l) => l.id)).toEqual(['stale-1']);
  });

  it('only looks up status history for contacted/quoted/won leads', async () => {
    const { service, historyLookup } = makeNeedsYouService({
      leads: [
        lead('new-1', 'new'),
        lead('c-1', 'contacted'),
        lead('q-1', 'quoted'),
        lead('w-1', 'won'),
        lead('l-1', 'lost'),
      ],
    });

    await service.getNeedsYou('elite-craft');

    expect(historyLookup).toHaveBeenCalledTimes(1);
    expect([...(historyLookup.mock.calls[0]?.[0] ?? [])].sort()).toEqual([
      'c-1',
      'q-1',
      'w-1',
    ]);
  });

  it('falls back to updatedAt when no status-change store is wired', async () => {
    const { service } = makeNeedsYouService({
      withStatusChanges: false,
      leads: [
        lead('old', 'quoted', { updatedAt: daysAgo(9) }),
        lead('recent', 'quoted', { updatedAt: daysAgo(1) }),
      ],
    });

    const result = await service.getNeedsYou('elite-craft');

    expect(result.stale.map((l) => l.id)).toEqual(['old']);
  });

  it('is tenant-scoped: another builder never sees these leads', async () => {
    const { service } = makeNeedsYouService({
      leads: [
        lead('mine', 'new'),
        lead('theirs', 'new', { builderId: OTHER_BUILDER_ID }),
      ],
    });

    const mine = await service.getNeedsYou('elite-craft');
    const theirs = await service.getNeedsYou('other');

    expect(mine.uncontacted.map((l) => l.id)).toEqual(['mine']);
    expect(mine.counts.total).toBe(1);
    expect(theirs.uncontacted.map((l) => l.id)).toEqual(['theirs']);
    expect(theirs.counts.total).toBe(1);
  });

  it('scans at most the configured number of leads', async () => {
    const { service, listSpy } = makeNeedsYouService({ leads: [] });

    const result = await service.getNeedsYou('elite-craft');

    expect(listSpy).toHaveBeenCalledWith({ builderId: ELITE_BUILDER_ID, limit: 250 });
    expect(result).toEqual({
      uncontacted: [],
      stale: [],
      wonWithoutContract: [],
      staleAfterDays: 7,
      counts: { total: 0, new: 0, contacted: 0, quoted: 0, won: 0, lost: 0 },
    });
  });

  it('throws 404 for an unknown or inactive builder', async () => {
    const { service } = makeNeedsYouService({ leads: [] });
    await expect(service.getNeedsYou('nope')).rejects.toMatchObject({ status: 404 });
    await expect(service.getNeedsYou('inactive')).rejects.toMatchObject({ status: 404 });
  });

  it('fails with 500 instead of inventing a threshold when unconfigured', async () => {
    const { service } = makeNeedsYouService({ leads: [], withConfig: false });
    await expect(service.getNeedsYou('elite-craft')).rejects.toMatchObject({ status: 500 });
  });

  it('never leaks invoice or rate fields onto the items', async () => {
    const { service } = makeNeedsYouService({ leads: [lead('won-1', 'won')] });
    const result = await service.getNeedsYou('elite-craft');
    expect(Object.keys(result.wonWithoutContract[0] ?? {}).sort()).toEqual([
      'addressKey',
      'createdAt',
      'email',
      'id',
      'leadScore',
      'name',
      'phone',
      'status',
      'statusChangedAt',
      'timeline',
      'waitingSince',
    ]);
  });
});

describe('builder-leads sandbox leads never enter billing (#840)', () => {
  function makeSandboxDeps() {
    const base = makeDeps();
    base.leads.set('lead-1', { ...makeLead({ id: 'lead-1' }), sandbox: true });
    const recordBillableEvent = vi.fn(async () => ({ billed: true }));
    const service = createBuilderLeadsService({
      leadStore: base.leadStore,
      audit: base.audit,
      builders: base.builders,
      billingHook: { recordBillableEvent } as never,
    });
    return { ...base, service, recordBillableEvent };
  }

  it('updateStatus to won is refused with 409 and no billing or status write', async () => {
    const { service, recordBillableEvent, leads, statusHistory } = makeSandboxDeps();
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
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(recordBillableEvent).not.toHaveBeenCalled();
    expect(leads.get('lead-1')?.status).toBe('new');
    expect(statusHistory).toEqual([]);
  });

  it('markWon is refused with 409 and no billing', async () => {
    const { service, recordBillableEvent, leads } = makeSandboxDeps();
    await expect(
      service.markWon('lead-1', 'elite-craft', 'member@elite.example'),
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(recordBillableEvent).not.toHaveBeenCalled();
    expect(leads.get('lead-1')?.status).toBe('new');
  });

  it('non-won transitions on a sandbox lead still work', async () => {
    const { service, leads } = makeSandboxDeps();
    await service.updateStatus(
      'lead-1',
      { status: 'contacted' },
      'elite-craft',
      'builder@example.com',
    );
    expect(leads.get('lead-1')?.status).toBe('contacted');
  });
});
