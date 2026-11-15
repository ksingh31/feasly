/**
 * Builder billing overview service (#531 — Money page header).
 *
 * Pins the aggregation over the tenant's invoice summaries:
 * - outstanding = unpaid, non-disputed invoices (draft, in_review,
 *   finalized, failed); paid/void/disputed excluded.
 * - next auto-charge = earliest-due in_review CARD invoice (manual
 *   methods never auto-charge), with the card-on-file last4.
 * - failed invoices listed newest first + counted.
 * - rate comes from the tenant config (CommissionService), default 1%.
 * - flat model: commission-only reads are skipped, never 409.
 * - tenant scoping: every dependency is called with the given tenant key.
 *
 * Fakes in-memory: db faked at the store/service interfaces.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBillingOverviewService } from '../src/services/billing/billing-overview.service';
import type { InvoiceSummaryRecord } from '../src/services/billing/invoice-summary.store';
import type { CommissionCardStatus } from '../src/services/billing/commission-card.service';

const TENANT = 'elite-craft';

function inv(
  overrides: Partial<InvoiceSummaryRecord> & Pick<InvoiceSummaryRecord, 'id' | 'status'>,
): InvoiceSummaryRecord {
  return {
    leadId: `lead-${overrides.id}`,
    invoiceNumber: `INV-${overrides.id}`,
    contractValueCents: 50_000_000,
    commissionCents: 500_000,
    currency: 'CAD',
    reviewDueAt: null,
    paymentMethod: 'card',
    ...overrides,
  };
}

function makeService(opts?: {
  readonly invoices?: readonly InvoiceSummaryRecord[];
  readonly model?: 'commission' | 'flat';
  readonly ratePercent?: number;
  readonly card?: CommissionCardStatus;
}) {
  const findByTenantKey = vi.fn(async (tenantKey: string) =>
    tenantKey === TENANT ? (opts?.invoices ?? []) : [],
  );
  const getCommissionRatePercent = vi.fn(async () => opts?.ratePercent ?? 1);
  const getCard = vi.fn(
    async (): Promise<CommissionCardStatus> => opts?.card ?? { hasCard: false },
  );
  const service = createBillingOverviewService({
    billing: { model: opts?.model ?? 'commission', flatCurrency: 'CAD' },
    invoiceSummaries: { findByTenantKey },
    commission: { getCommissionRatePercent },
    commissionCard: { getCard },
  });
  return { service, findByTenantKey, getCommissionRatePercent, getCard };
}

describe('BillingOverviewService.getOverview', () => {
  it('returns an empty header for a builder with no invoices (default 1% rate)', async () => {
    const { service } = makeService();
    await expect(service.getOverview(TENANT)).resolves.toEqual({
      planType: 'commission',
      commissionRatePercent: 1,
      currency: 'CAD',
      outstandingCents: 0,
      outstandingCount: 0,
      nextCharge: null,
      failedCount: 0,
      failedInvoices: [],
      disputedCount: 0,
      card: { hasCard: false },
    });
  });

  it('scopes every read to the tenant key', async () => {
    const { service, findByTenantKey, getCommissionRatePercent, getCard } =
      makeService();
    await service.getOverview(TENANT);
    expect(findByTenantKey).toHaveBeenCalledWith(TENANT);
    expect(getCommissionRatePercent).toHaveBeenCalledWith(TENANT);
    expect(getCard).toHaveBeenCalledWith(TENANT);
  });

  it('returns the tenant-configured (negotiated) rate', async () => {
    const { service } = makeService({ ratePercent: 1.5 });
    const result = await service.getOverview(TENANT);
    expect(result.commissionRatePercent).toBe(1.5);
  });

  it('sums outstanding over unpaid, non-disputed invoices only', async () => {
    const { service } = makeService({
      invoices: [
        inv({ id: '1', status: 'draft', commissionCents: 100 }),
        inv({ id: '2', status: 'in_review', commissionCents: 200 }),
        inv({ id: '3', status: 'finalized', commissionCents: 400 }),
        inv({ id: '4', status: 'failed', commissionCents: 800 }),
        inv({ id: '5', status: 'paid', commissionCents: 1_600 }),
        inv({ id: '6', status: 'void', commissionCents: 3_200 }),
        inv({ id: '7', status: 'disputed', commissionCents: 6_400 }),
      ],
    });
    const result = await service.getOverview(TENANT);
    expect(result.outstandingCents).toBe(1_500);
    expect(result.outstandingCount).toBe(4);
    expect(result.disputedCount).toBe(1);
  });

  it('lists failed invoices newest first with their count', async () => {
    const { service } = makeService({
      invoices: [
        inv({ id: '9', status: 'failed', commissionCents: 900 }),
        inv({ id: '8', status: 'paid' }),
        inv({ id: '7', status: 'failed', commissionCents: 700 }),
      ],
    });
    const result = await service.getOverview(TENANT);
    expect(result.failedCount).toBe(2);
    expect(result.failedInvoices).toEqual([
      { id: '9', invoiceNumber: 'INV-9', leadId: 'lead-9', commissionCents: 900 },
      { id: '7', invoiceNumber: 'INV-7', leadId: 'lead-7', commissionCents: 700 },
    ]);
  });

  it('picks the earliest-due in-review card invoice as the next charge, with card last4', async () => {
    const { service } = makeService({
      card: { hasCard: true, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
      invoices: [
        inv({
          id: 'late',
          status: 'in_review',
          commissionCents: 300,
          reviewDueAt: new Date('2026-11-25T00:00:00.000Z'),
        }),
        inv({
          id: 'manual',
          status: 'in_review',
          paymentMethod: 'cheque',
          commissionCents: 999,
          reviewDueAt: new Date('2026-11-16T00:00:00.000Z'),
        }),
        inv({
          id: 'disputed',
          status: 'disputed',
          commissionCents: 888,
          reviewDueAt: new Date('2026-11-17T00:00:00.000Z'),
        }),
        inv({
          id: 'soon',
          status: 'in_review',
          commissionCents: 250,
          reviewDueAt: new Date('2026-11-20T00:00:00.000Z'),
        }),
      ],
    });
    const result = await service.getOverview(TENANT);
    expect(result.nextCharge).toEqual({
      invoiceId: 'soon',
      invoiceNumber: 'INV-soon',
      amountCents: 250,
      chargeAt: '2026-11-20T00:00:00.000Z',
      cardLast4: '4242',
    });
    expect(result.card).toEqual({
      hasCard: true,
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
    });
  });

  it('breaks a due-date tie on invoice number (deterministic)', async () => {
    const due = new Date('2026-11-20T00:00:00.000Z');
    const { service } = makeService({
      invoices: [
        inv({ id: '0002', status: 'in_review', reviewDueAt: due }),
        inv({ id: '0001', status: 'in_review', reviewDueAt: due }),
      ],
    });
    const result = await service.getOverview(TENANT);
    expect(result.nextCharge?.invoiceId).toBe('0001');
  });

  it('still reports the next charge with a null last4 when no card is saved', async () => {
    const { service } = makeService({
      invoices: [
        inv({
          id: '1',
          status: 'in_review',
          reviewDueAt: new Date('2026-11-20T00:00:00.000Z'),
        }),
      ],
    });
    const result = await service.getOverview(TENANT);
    expect(result.nextCharge?.cardLast4).toBeNull();
  });

  it('has no next charge when only manual-method invoices are in review', async () => {
    const { service } = makeService({
      invoices: [
        inv({
          id: '1',
          status: 'in_review',
          paymentMethod: 'e_transfer',
          reviewDueAt: new Date('2026-11-20T00:00:00.000Z'),
        }),
      ],
    });
    const result = await service.getOverview(TENANT);
    expect(result.nextCharge).toBeNull();
    expect(result.outstandingCount).toBe(1);
  });

  it('uses the invoices\' currency when present', async () => {
    const { service } = makeService({
      invoices: [inv({ id: '1', status: 'paid', currency: 'USD' })],
    });
    const result = await service.getOverview(TENANT);
    expect(result.currency).toBe('USD');
  });

  it('under the flat model skips commission-only reads instead of failing', async () => {
    const { service, getCommissionRatePercent, getCard } = makeService({
      model: 'flat',
      invoices: [
        inv({
          id: '1',
          status: 'in_review',
          reviewDueAt: new Date('2026-11-20T00:00:00.000Z'),
        }),
      ],
    });
    const result = await service.getOverview(TENANT);
    expect(getCommissionRatePercent).not.toHaveBeenCalled();
    expect(getCard).not.toHaveBeenCalled();
    expect(result.planType).toBe('flat');
    expect(result.commissionRatePercent).toBeNull();
    expect(result.card).toBeNull();
    expect(result.nextCharge).toBeNull();
  });
});
