/**
 * Builder billing actions (billing/02, BILL-02). All card-on-file state
 * lives in BuilderBillingState — components dispatch and render selectors,
 * never call the API directly.
 */

/** Loads the tenant's card-on-file status. */
export class LoadBillingCard {
  static readonly type = '[BuilderBilling] Load card';
}

/** Resets billing state (after logout). */
export class ClearBillingState {
  static readonly type = '[BuilderBilling] Clear';
}
