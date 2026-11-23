/**
 * Billing-health dashboard actions (billing/03 follow-on — /admin/billing).
 */
import type {
  BuilderPaymentMethod,
  CorrectContractRequest,
  ManualInvoiceRequest,
  MarkInvoicePaidRequest,
  RefundInvoiceRequest,
  ReverseManualPaymentRequest,
  UpdateInvoiceDunningRequest,
  VoidInvoiceRequest,
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

/**
 * Search a builder's leads for the create-invoice lead picker (#544).
 * Leads are matched by builder assignment (`builderId`) — the same scope
 * the server checks when the invoice is created — plus an optional
 * free-text `search` (name, email or address). A newer search cancels an
 * in-flight one.
 */
export class SearchInvoiceLeads {
  static readonly type = '[BillingHealth] Search invoice leads';
  constructor(
    public readonly builderId: string,
    public readonly search: string,
  ) {}
}

/** Clear the lead-picker results (builder changed or modal closed). */
export class ClearInvoiceLeads {
  static readonly type = '[BillingHealth] Clear invoice leads';
}

/**
 * #901: edit one dunning invoice's automatic-retry schedule — pause,
 * resume, cancel, or set its grace days. The state reloads the dashboard
 * on success so the queue shows the new next-retry date and state.
 */
export class UpdateInvoiceDunning {
  static readonly type = '[BillingHealth] Update invoice dunning';
  constructor(
    public readonly invoiceId: string,
    public readonly body: UpdateInvoiceDunningRequest,
  ) {}
}

/**
 * #862: refund a paid invoice in full or in part (#715). A money action:
 * the refund modal shows the before → after and needs a deliberate
 * confirm. The body carries one idempotency key per modal open, so a
 * retry or double-click never refunds twice.
 */
export class RefundInvoice {
  static readonly type = '[BillingHealth] Refund invoice';
  constructor(
    public readonly invoiceId: string,
    public readonly body: RefundInvoiceRequest,
  ) {}
}

/** #862: void an invoice that should not be charged (draft, in review, failed). */
export class VoidInvoice {
  static readonly type = '[BillingHealth] Void invoice';
  constructor(
    public readonly invoiceId: string,
    public readonly body: VoidInvoiceRequest,
  ) {}
}

/**
 * #862: correct the reported contract on an invoice that has not been
 * charged yet (draft, in review). The server recalculates the amounts.
 */
export class CorrectInvoiceContract {
  static readonly type = '[BillingHealth] Correct invoice contract';
  constructor(
    public readonly invoiceId: string,
    public readonly body: CorrectContractRequest,
  ) {}
}

/** #862: undo a manual mark-paid when the money never arrived. */
export class ReverseInvoicePayment {
  static readonly type = '[BillingHealth] Reverse invoice payment';
  constructor(
    public readonly invoiceId: string,
    public readonly body: ReverseManualPaymentRequest,
  ) {}
}
