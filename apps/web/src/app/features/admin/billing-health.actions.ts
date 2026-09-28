/**
 * Billing-health dashboard actions (billing/03 follow-on — /admin/billing).
 */
import type { ManualInvoiceRequest } from '@feasly/contracts';

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
