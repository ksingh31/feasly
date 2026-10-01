/**
 * Builder invoices actions (BILL-04; per-invoice payment method
 * billing/12). All invoice state lives in BuilderInvoicesState —
 * components dispatch and render selectors, never call the API directly.
 */
import type { BuilderPaymentMethod } from './builder-payment-methods';

/** Loads a page of the tenant's commission invoices, newest first. */
export class LoadInvoices {
  static readonly type = '[BuilderInvoices] Load page';
  constructor(public readonly page: number) {}
}

/**
 * Sets the invoice-number search filter and reloads from page 1. The
 * filter is server-side (partial, case-insensitive match) so it finds
 * invoices on any page; an empty value clears the filter.
 */
export class SetInvoiceNumberFilter {
  static readonly type = '[BuilderInvoices] Set invoice number filter';
  constructor(public readonly invoiceNumber: string) {}
}

/** Loads a single invoice into the detail view. */
export class SelectInvoice {
  static readonly type = '[BuilderInvoices] Select invoice';
  constructor(public readonly id: string) {}
}

/** Changes an invoice's payment method (billing/12). */
export class UpdateInvoicePaymentMethod {
  static readonly type = '[BuilderInvoices] Update payment method';
  constructor(
    public readonly id: string,
    public readonly method: BuilderPaymentMethod,
  ) {}
}

/** Closes the detail view (keeps the loaded list). */
export class ClearInvoiceSelection {
  static readonly type = '[BuilderInvoices] Clear selection';
}

/** Resets invoice state (after logout). */
export class ClearInvoicesState {
  static readonly type = '[BuilderInvoices] Clear';
}
