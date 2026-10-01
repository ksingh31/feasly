import type { BuilderPaymentMethod } from './builder-payment-methods';

/**
 * Builder billing actions (billing/02, BILL-02; default payment method
 * billing/12). All card-on-file state lives in BuilderBillingState —
 * components dispatch and render selectors, never call the API directly.
 */

/** Loads the tenant's card-on-file status. */
export class LoadBillingCard {
  static readonly type = '[BuilderBilling] Load card';
}

/** Loads the builder's default payment method for new invoices. */
export class LoadDefaultPaymentMethod {
  static readonly type = '[BuilderBilling] Load default payment method';
}

/** Persists a new default payment method for future invoices. */
export class SetDefaultPaymentMethod {
  static readonly type = '[BuilderBilling] Set default payment method';
  constructor(public readonly method: BuilderPaymentMethod) {}
}

/** Resets billing state (after logout). */
export class ClearBillingState {
  static readonly type = '[BuilderBilling] Clear';
}
