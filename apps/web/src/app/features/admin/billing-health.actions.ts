/**
 * Billing-health dashboard actions (billing/03 follow-on — /admin/billing).
 */

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
