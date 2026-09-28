/**
 * Builder invoices actions (BILL-04). All invoice state lives in
 * BuilderInvoicesState — components dispatch and render selectors, never
 * call the API directly.
 */

/** Loads a page of the tenant's commission invoices, newest first. */
export class LoadInvoices {
  static readonly type = '[BuilderInvoices] Load page';
  constructor(public readonly page: number) {}
}

/** Loads a single invoice into the detail view. */
export class SelectInvoice {
  static readonly type = '[BuilderInvoices] Select invoice';
  constructor(public readonly id: string) {}
}

/** Closes the detail view (keeps the loaded list). */
export class ClearInvoiceSelection {
  static readonly type = '[BuilderInvoices] Clear selection';
}

/** Resets invoice state (after logout). */
export class ClearInvoicesState {
  static readonly type = '[BuilderInvoices] Clear';
}
