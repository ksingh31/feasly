/**
 * Embed billing hook (billing/01 first charge path).
 *
 * The single seam where billable events in the embed/builder track turn into
 * real billing. The embed/04 no-op placeholder was deleted here and replaced
 * with the actual charge path — per the placeholder's own IRON RULE, the
 * charge path is built here, not beside it.
 *
 * Model gate: the active charge path is selected by `BILLING_MODEL`
 * (zod-validated config; Karan 2026-09-24: 1% commission, switchable to
 * flat with a config change — no code change).
 *
 * - commission + `lead_won` + contract details → attribution (find the
 *   lead's open introduction, or record one backdated to the introduction)
 *   → report the signed contract → exactly one draft commission invoice →
 *   auto-submitted into the 7-day review window. The invoice-reviewer timer
 *   creates the off-session Stripe PaymentIntent when the window passes;
 *   webhooks settle paid/failed. Disputes freeze the charge clock.
 * - commission + `lead_won` WITHOUT contract details → audit-logged and
 *   parked: the builder reports the contract later via
 *   `POST /api/v1/billing/report-contract`, which runs this same flow.
 * - flat model → audit-logged only; the flat subscription (card on file at
 *   signup) is the charge path, not per-event billing.
 * - `lead_created` → audit-logged only (introductions are not billable).
 *
 * Every invocation appends `billing_events` rows via BillingAuditService.
 * No PII in logs — tenant keys and ids only, never amounts in messages
 * (amounts live in the structured audit payload).
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts. This service never touches db directly.
 */
import type { BillingConfig } from '../../config';
import type { AttributionService } from './attribution.service';
import type { BillingAuditService } from './billing-audit.service';
import type { CommissionService } from './commission.service';

/** Billable events in the embed/builder track. */
export type BillableEventType = 'lead_created' | 'lead_won';

/**
 * Detail for `lead_won`. Contract fields are optional: a won deal reported
 * without them is parked until the builder reports the signed contract
 * (POST /api/v1/billing/report-contract).
 */
export interface LeadWonDetail {
  readonly leadId: string;
  /** When the lead was introduced to the builder (defaults to now). */
  readonly introducedAt?: Date;
  /** Signed construction contract value in integer cents, EXCLUDING land. */
  readonly contractValueCents?: number;
  readonly contractSignedAt?: Date;
}

export type BillableEventResult =
  | {
      readonly billed: true;
      readonly invoiceId: string;
      readonly invoiceStatus: string;
      /**
       * Set on idempotent retries: 'existing_invoice' when the invoice was
       * already created, 'existing_disputed' when it is under dispute (the
       * charge clock is frozen — no new invoice is minted).
       */
      readonly reason?: 'existing_invoice' | 'existing_disputed';
    }
  | {
      readonly billed: false;
      readonly reason:
        | 'billing_not_enabled'
        | 'flat_subscription_covers'
        | 'awaiting_contract_details';
    };

export interface EmbedBillingHookService {
  /**
   * Record a billable event for a tenant and run the active charge path.
   *
   * Idempotent for `lead_won`: a second won report for the same lead
   * returns the existing invoice instead of creating a duplicate.
   */
  recordBillableEvent(
    tenantKey: string,
    event: BillableEventType,
    detail?: LeadWonDetail,
  ): Promise<BillableEventResult>;
}

export interface EmbedBillingHookServiceDeps {
  readonly billing: BillingConfig;
  readonly attribution: AttributionService;
  readonly commission: CommissionService;
  readonly audit: BillingAuditService;
  /** Defaults to () => new Date(); tests inject a fixed clock. */
  readonly now?: () => Date;
}

const NOT_BILLABLE: BillableEventResult = Object.freeze({
  billed: false,
  reason: 'billing_not_enabled',
} as const);

const FLAT_SUBSCRIPTION: BillableEventResult = Object.freeze({
  billed: false,
  reason: 'flat_subscription_covers',
} as const);

const AWAITING_CONTRACT: BillableEventResult = Object.freeze({
  billed: false,
  reason: 'awaiting_contract_details',
} as const);

export function createEmbedBillingHookService(
  deps: EmbedBillingHookServiceDeps,
): EmbedBillingHookService {
  const { billing, attribution, commission, audit } = deps;
  const now = deps.now ?? (() => new Date());

  async function auditEvent(
    tenantKey: string,
    eventType: string,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await audit.append({
      tenantKey,
      eventType,
      entityType,
      entityId,
      payload,
    });
  }

  /**
   * The commission charge path for a won deal with reported contract
   * details. Idempotent: an already-invoiced lead returns the existing
   * invoice instead of double-billing. The per-lead invoice check runs
   * FIRST — before any new introduction is recorded — so a retried won
   * event can never mint a second attribution + invoice.
   */
  async function chargeCommission(
    tenantKey: string,
    detail: LeadWonDetail,
  ): Promise<BillableEventResult> {
    const existingInvoice = await commission.findByLead(detail.leadId);
    if (existingInvoice !== null) {
      const reason =
        existingInvoice.status === 'disputed'
          ? 'existing_disputed'
          : 'existing_invoice';
      await auditEvent(
        tenantKey,
        'billing.won_duplicate',
        'commission_invoice',
        existingInvoice.id,
        {
          leadId: detail.leadId,
          attributionId: existingInvoice.attributionId,
          reason,
        },
      );
      return {
        billed: true,
        reason,
        invoiceId: existingInvoice.id,
        invoiceStatus: existingInvoice.status,
      };
    }

    const introducedAt = detail.introducedAt ?? now();
    const record =
      (await attribution.findOpenByLead(detail.leadId, tenantKey)) ??
      (await attribution.recordIntroduction({
        leadId: detail.leadId,
        tenantKey,
        introducedAt,
      }));

    const attributed = await attribution.reportContract({
      attributionId: record.id,
      // Validated present by the caller before chargeCommission runs.
      contractValueCents: detail.contractValueCents as number,
      contractSignedAt: detail.contractSignedAt as Date,
      reportedAt: now(),
    });
    const invoice = await commission.createDraftInvoice(attributed.id);
    // Auto-enter the review window: the invoice-reviewer timer charges when
    // the window passes (unless disputed — disputes freeze the clock).
    const inReview = await commission.submitForReview(invoice.id);
    await auditEvent(
      tenantKey,
      'billing.won_invoiced',
      'commission_invoice',
      inReview.id,
      {
        leadId: detail.leadId,
        attributionId: attributed.id,
        commissionCents: inReview.commissionCents,
      },
    );
    return {
      billed: true,
      invoiceId: inReview.id,
      invoiceStatus: inReview.status,
    };
  }

  return {
    async recordBillableEvent(
      tenantKey: string,
      event: BillableEventType,
      detail?: LeadWonDetail,
    ): Promise<BillableEventResult> {
      if (event === 'lead_created') {
        await auditEvent(
          tenantKey,
          'embed.lead_created',
          'embed_billing_hook',
          `${tenantKey}:lead_created:${detail?.leadId ?? 'unknown'}`,
          { event, billed: false },
        );
        return NOT_BILLABLE;
      }

      // event === 'lead_won'
      const leadId = detail?.leadId ?? '';
      if (billing.model === 'flat') {
        await auditEvent(
          tenantKey,
          'embed.lead_won',
          'embed_billing_hook',
          `${tenantKey}:lead_won:${leadId}`,
          { event, billed: false, reason: 'flat_subscription_covers' },
        );
        return FLAT_SUBSCRIPTION;
      }

      // commission model
      if (
        detail === undefined ||
        detail.contractValueCents === undefined ||
        detail.contractSignedAt === undefined
      ) {
        await auditEvent(
          tenantKey,
          'billing.won_pending_contract',
          'embed_billing_hook',
          `${tenantKey}:lead_won:${leadId}`,
          {
            event,
            billed: false,
            reason: 'awaiting_contract_details',
            leadId,
          },
        );
        return AWAITING_CONTRACT;
      }

      return chargeCommission(tenantKey, detail);
    },
  };
}
