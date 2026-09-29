/**
 * Billing service facade tests (billing/01).
 *
 * The facade is a thin orchestrator; its critical property is tenant
 * isolation plus the lead lookup for the report-contract path:
 * - reportContract: 404 for an unknown lead, 403 for another builder's
 *   lead (auth/04 iron rule: scoped by (id, builder_id) resolved from
 *   the session's tenant key — never by the lead row's tenant_key,
 *   which can legitimately be NULL/diverged on builder-scoped rows),
 *   and delegates to the billing hook with the lead's introduction
 *   date (not "now") so the attribution window is measured correctly.
 * - getInvoice / disputeInvoice: 403 when the invoice belongs to another
 *   tenant (the commission service itself is tenant-agnostic).
 * - resolveDispute: delegates straight through (admin-only at the route).
 *
 * Fakes in-memory: no DB, no network.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createBillingService,
  type BillingServiceDeps,
} from '../src/services/billing/billing.service';
import type { EmbedBillingHookService } from '../src/services/billing/embed-billing-hook.service';
import type { CommissionService } from '../src/services/billing/commission.service';
import type { LeadStore } from '../src/services/lead.store';
import type { BuilderService } from '../src/services/builder.service';

const ELITE_BUILDER_ID = 'builder-elite-id';
const OTHER_BUILDER_ID = 'builder-other-id';

/**
 * Leads as the real store would carry them: the happy-path lead is
 * assigned to Elite via builder_id but has tenant_key NULL — the exact
 * divergence that used to 403 a builder-visible lead.
 */
function makeDeps() {
  const leads = new Map([
    [
      'lead-1',
      {
        id: 'lead-1',
        tenantKey: null,
        builderId: ELITE_BUILDER_ID,
        createdAt: new Date('2026-03-01T10:00:00.000Z'),
      },
    ],
    [
      'lead-other',
      {
        id: 'lead-other',
        tenantKey: null,
        builderId: OTHER_BUILDER_ID,
        createdAt: new Date('2026-03-02T10:00:00.000Z'),
      },
    ],
  ]);
  const leadStore = {
    findByIdAndBuilderId: vi.fn(
      async ({ id, builderId }: { id: string; builderId: string }) => {
        const lead = leads.get(id);
        return lead !== undefined && lead.builderId === builderId
          ? lead
          : null;
      },
    ),
    existsById: vi.fn(async (id: string) => leads.has(id)),
  } as unknown as LeadStore;

  const builders = {
    getByTenantKey: vi.fn(async (tenantKey: string) => {
      if (tenantKey === 'elite-craft') {
        return {
          id: ELITE_BUILDER_ID,
          tenantKey: 'elite-craft',
          status: 'active',
        };
      }
      return null;
    }),
  } as unknown as Pick<BuilderService, 'getByTenantKey'>;

  const billingHook = {
    recordBillableEvent: vi.fn(async () => ({
      billed: true,
      invoiceId: 'inv-1',
      invoiceStatus: 'in_review',
    })),
  } as unknown as EmbedBillingHookService;

  const invoice = {
    id: 'inv-1',
    tenantKey: 'elite-craft',
    status: 'in_review',
  };
  const commission = {
    getById: vi.fn(async (id: string) => {
      if (id !== 'inv-1') {
        throw Object.assign(new Error('not found'), { status: 404 });
      }
      return invoice;
    }),
    disputeInvoice: vi.fn(async () => ({ ...invoice, status: 'disputed' })),
    resolveDispute: vi.fn(async () => ({ ...invoice, status: 'in_review' })),
  } as unknown as CommissionService;

  const deps: BillingServiceDeps = {
    leadStore,
    billingHook,
    commission,
    builders,
  };
  return {
    service: createBillingService(deps),
    leadStore,
    billingHook,
    commission,
    builders,
  };
}

describe('billing service facade', () => {
  it('reportContract succeeds for a builder-scoped lead with NULL tenant_key', async () => {
    // Regression (Karan, 2026-09-29): lead-1 is assigned to Elite via
    // builder_id but carries tenant_key NULL — it shows in the builder's
    // pipeline and must be reportable.
    const { service, leadStore, billingHook } = makeDeps();
    const result = await service.reportContract({
      tenantKey: 'elite-craft',
      leadId: 'lead-1',
      contractValueCents: 50_000_000,
      contractSignedAt: new Date('2026-09-20T10:00:00.000Z'),
    });

    expect(leadStore.findByIdAndBuilderId).toHaveBeenCalledWith({
      id: 'lead-1',
      builderId: ELITE_BUILDER_ID,
    });
    expect(billingHook.recordBillableEvent).toHaveBeenCalledWith(
      'elite-craft',
      'lead_won',
      {
        leadId: 'lead-1',
        introducedAt: new Date('2026-03-01T10:00:00.000Z'),
        contractValueCents: 50_000_000,
        contractSignedAt: new Date('2026-09-20T10:00:00.000Z'),
      },
    );
    expect(result).toMatchObject({ billed: true, invoiceId: 'inv-1' });
  });

  it('reportContract 404s for an unknown lead', async () => {
    const { service, billingHook } = makeDeps();
    await expect(
      service.reportContract({
        tenantKey: 'elite-craft',
        leadId: 'nope',
        contractValueCents: 50_000_000,
        contractSignedAt: new Date(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(billingHook.recordBillableEvent).not.toHaveBeenCalled();
  });

  it('reportContract 403s for another builder lead with the exact message', async () => {
    const { service, billingHook, leadStore } = makeDeps();
    await expect(
      service.reportContract({
        tenantKey: 'elite-craft',
        leadId: 'lead-other',
        contractValueCents: 50_000_000,
        contractSignedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: 'This lead belongs to a different builder.',
    });
    expect(leadStore.existsById).toHaveBeenCalledWith('lead-other');
    expect(billingHook.recordBillableEvent).not.toHaveBeenCalled();
  });

  it('reportContract 404s for an unknown tenant key', async () => {
    const { service, billingHook } = makeDeps();
    await expect(
      service.reportContract({
        tenantKey: 'no-such-builder',
        leadId: 'lead-1',
        contractValueCents: 50_000_000,
        contractSignedAt: new Date(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(billingHook.recordBillableEvent).not.toHaveBeenCalled();
  });

  it('getInvoice 403s for another tenant invoice', async () => {
    const { service } = makeDeps();
    await expect(
      service.getInvoice('inv-1', 'other-builder'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('getInvoice passes null tenant for admins', async () => {
    const { service, commission } = makeDeps();
    await service.getInvoice('inv-1', null);
    expect(commission.getById).toHaveBeenCalledWith('inv-1');
  });

  it('disputeInvoice checks the tenant then disputes', async () => {
    const { service, commission } = makeDeps();
    const result = await service.disputeInvoice(
      'inv-1',
      'elite-craft',
      'disagree',
    );
    expect(commission.disputeInvoice).toHaveBeenCalledWith('inv-1', 'disagree');
    expect(result).toMatchObject({ status: 'disputed' });
  });

  it('resolveDispute delegates straight through', async () => {
    const { service, commission } = makeDeps();
    await service.resolveDispute('inv-1', 'void');
    expect(commission.resolveDispute).toHaveBeenCalledWith('inv-1', 'void');
  });
});
