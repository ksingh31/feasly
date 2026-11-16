/**
 * Builder billing overview (portal redesign — Money page header, #531).
 *
 * One tenant-scoped read that powers the Money page header in a single
 * call: outstanding total, the next card auto-charge, failed invoices,
 * plan type + the builder org's configured commission rate, and the card
 * on file. Read-only — no charge-path logic lives here.
 *
 * Figures are aggregated from the tenant's commission invoices (already
 * computed integer cents) — this service sums and selects, it never
 * derives a commission from a contract value.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts. This service never touches db directly; it
 * reads through the injected InvoiceSummaryStore / CommissionService /
 * CommissionCardService interfaces.
 */
import type {
  BillingOverviewFailedInvoice,
  BillingOverviewNextCharge,
  BuilderBillingOverviewResponse,
} from '@feasly/contracts';
import type { BillingConfig } from '../../config';
import type { CommissionCardService } from './commission-card.service';
import type { CommissionService } from './commission.service';
import type {
  InvoiceSummaryRecord,
  InvoiceSummaryStore,
} from './invoice-summary.store';

/** Unpaid statuses whose commission is still owed (disputed excluded). */
const OUTSTANDING_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'in_review',
  'finalized',
  'failed',
]);

export interface BillingOverviewService {
  /** The Money page header for one builder tenant. */
  getOverview(tenantKey: string): Promise<BuilderBillingOverviewResponse>;
}

export interface BillingOverviewServiceDeps {
  readonly billing: Pick<BillingConfig, 'model' | 'flatCurrency' | 'tax'>;
  readonly invoiceSummaries: Pick<InvoiceSummaryStore, 'findByTenantKey'>;
  readonly commission: Pick<CommissionService, 'getCommissionRatePercent'>;
  readonly commissionCard: Pick<CommissionCardService, 'getCard'>;
}

/**
 * The earliest-due in-review card invoice — what the invoice-reviewer
 * timer charges next. Manual-method invoices never auto-charge; disputed
 * ones are frozen. Ties on the due date break on invoice number so the
 * pick is deterministic.
 */
function pickNextCharge(
  invoices: readonly InvoiceSummaryRecord[],
): InvoiceSummaryRecord | null {
  let next: InvoiceSummaryRecord | null = null;
  for (const inv of invoices) {
    if (inv.status !== 'in_review' || inv.paymentMethod !== 'card') continue;
    if (inv.reviewDueAt === null) continue;
    if (
      next === null ||
      next.reviewDueAt === null ||
      inv.reviewDueAt.getTime() < next.reviewDueAt.getTime() ||
      (inv.reviewDueAt.getTime() === next.reviewDueAt.getTime() &&
        inv.invoiceNumber < next.invoiceNumber)
    ) {
      next = inv;
    }
  }
  return next;
}

export function createBillingOverviewService(
  deps: BillingOverviewServiceDeps,
): BillingOverviewService {
  const { billing, invoiceSummaries, commission, commissionCard } = deps;

  return {
    async getOverview(
      tenantKey: string,
    ): Promise<BuilderBillingOverviewResponse> {
      const isCommission = billing.model === 'commission';
      // Commission-only reads are model-gated in their services (409 under
      // flat), so skip them rather than fail the whole header.
      const [invoices, commissionRatePercent, card] = await Promise.all([
        invoiceSummaries.findByTenantKey(tenantKey),
        isCommission
          ? commission.getCommissionRatePercent(tenantKey)
          : Promise.resolve(null),
        isCommission
          ? commissionCard.getCard(tenantKey)
          : Promise.resolve(null),
      ]);

      let outstandingCents = 0;
      let outstandingCount = 0;
      let disputedCount = 0;
      const failedInvoices: BillingOverviewFailedInvoice[] = [];
      // findByTenantKey returns newest first, so failedInvoices is too.
      for (const inv of invoices) {
        if (OUTSTANDING_STATUSES.has(inv.status)) {
          // #714: outstanding = what the builder pays (incl. tax).
          outstandingCents += inv.totalCents ?? inv.commissionCents;
          outstandingCount += 1;
        }
        if (inv.status === 'disputed') disputedCount += 1;
        if (inv.status === 'failed') {
          failedInvoices.push({
            id: inv.id,
            invoiceNumber: inv.invoiceNumber,
            leadId: inv.leadId,
            commissionCents: inv.commissionCents,
          });
        }
      }

      const nextInvoice = isCommission ? pickNextCharge(invoices) : null;
      const nextCharge: BillingOverviewNextCharge | null =
        nextInvoice && nextInvoice.reviewDueAt
          ? {
              invoiceId: nextInvoice.id,
              invoiceNumber: nextInvoice.invoiceNumber,
              amountCents: nextInvoice.totalCents ?? nextInvoice.commissionCents,
              chargeAt: nextInvoice.reviewDueAt.toISOString(),
              cardLast4: card?.hasCard ? (card.last4 ?? null) : null,
            }
          : null;

      return {
        planType: billing.model,
        commissionRatePercent,
        // Invoices carry their own currency; with none yet, fall back to
        // the platform's configured billing currency.
        currency: invoices[0]?.currency ?? billing.flatCurrency,
        outstandingCents,
        outstandingCount,
        nextCharge,
        failedCount: failedInvoices.length,
        failedInvoices,
        disputedCount,
        card,
        // #764: the tax new invoices will carry, for the record-contract
        // preview. Supplier details stay server-side.
        ...(isCommission && billing.tax?.enabled && billing.tax.ratePercent > 0
          ? {
              tax: {
                ratePercent: billing.tax.ratePercent,
                label: billing.tax.label,
                inclusive: billing.tax.inclusive,
              },
            }
          : {}),
      };
    },
  };
}
