/**
 * Billing-health dashboard actions (billing/03 follow-on — /admin/billing).
 */
import type {
  BuilderPaymentMethod,
  ManualInvoiceRequest,
  MarkInvoicePaidRequest,
} from '@feasly/contracts';

/** Load the billing-health dashboard payload (refresh on each dispatch). */
export class LoadBillingHealth {
  static readonly type = '[BillingHealth] Load';
}

/**
 * Retry a failed commission charge (BILL-03). The state reloads the
 * dashboard payload on success so the dunning queue reflects the new
 * `in_review` status and retry count.
 */
export class RetryInvoiceCharge {
  static readonly type = '[BillingHealth] Retry invoice charge';
  constructor(public readonly invoiceId: string) {}
}

/**
 * Manually create a commission invoice for a builder's converted lead.
 * The state reloads the dashboard payload on success so the in-review
 * aging reflects the new invoice. A money action: the UI always
 * requires a deliberate confirm step before dispatching.
 */
export class CreateManualInvoice {
  static readonly type = '[BillingHealth] Create manual invoice';
  constructor(public readonly body: ManualInvoiceRequest) {}
}

/** Dismiss the create-invoice feedback banner. */
export class DismissCreateInvoiceFeedback {
  static readonly type = '[BillingHealth] Dismiss create-invoice feedback';
}

/**
 * Record an off-Stripe payment for a commission invoice (cheque, bank
 * draft, e-transfer, cash, card terminal, other). A money action: the UI
 * always requires a deliberate confirm step before dispatching. The
 * server marks the invoice paid AND cancels the scheduled auto-charge —
 * the builder can never be double-charged. The state reloads the
 * dashboard payload on success so the invoice leaves the work queue.
 */
export class MarkInvoicePaid {
  static readonly type = '[BillingHealth] Mark invoice paid';
  constructor(
    public readonly invoiceId: string,
    public readonly body: MarkInvoicePaidRequest,
  ) {}
}

/**
 * Override the per-invoice commission rate (percent, e.g. 1.5 = 1.5%).
 * A money action: the UI always requires a deliberate confirm step
 * before dispatching. The server recalculates the commission from the
 * signed contract value (excluding land); unpaid invoices only. The
 * state reloads the dashboard payload on success.
 */
export class SetCommissionRate {
  static readonly type = '[BillingHealth] Set commission rate';
  constructor(
    public readonly invoiceId: string,
    public readonly rate: number,
  ) {}
}

/** Dismiss the mark-paid / rate-override feedback banner. */
export class DismissInvoiceFeedback {
  static readonly type = '[BillingHealth] Dismiss invoice feedback';
}

/**
 * Change the planned payment method on one commission invoice (card,
 * cheque, e_transfer, bank_draft). Not a money action in the charge
 * sense, but it re-routes how the invoice gets paid — so the UI still
 * requires the deliberate two-click confirm. Choosing a manual method
 * pauses the Stripe auto-charge until staff marks the invoice paid. The
 * state reloads the dashboard payload on success.
 */
export class SetInvoicePlannedPaymentMethod {
  static readonly type = '[BillingHealth] Set invoice payment method';
  constructor(
    public readonly invoiceId: string,
    public readonly method: BuilderPaymentMethod,
  ) {}
}
