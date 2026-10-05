import type { CommissionInvoiceStatus } from '@feasly/contracts';

/**
 * Filters for the admin invoice list. `status` is a comma-separated list
 * of invoice statuses (or null for all); `invoiceNumber` is the partial
 * invoice-number search (or null for none).
 */
export interface AdminInvoiceFilters {
  readonly status: string | null;
  readonly invoiceNumber: string | null;
}

export class LoadAdminInvoices {
  static readonly type = '[AdminInvoices] Load invoices';
  constructor(
    public readonly page: number = 1,
    public readonly pageSize: number = 20,
    public readonly filters: AdminInvoiceFilters = { status: null, invoiceNumber: null },
  ) {}
}

/** Apply new filters to the invoice list (resets to page 1). */
export class SetAdminInvoiceFilters {
  static readonly type = '[AdminInvoices] Set filters';
  constructor(public readonly filters: AdminInvoiceFilters) {}
}

export class LoadAdminInvoiceDetail {
  static readonly type = '[AdminInvoices] Load invoice detail';
  constructor(public readonly id: string) {}
}

/** Clear the detail view (leaving the invoices page). */
export class ClearAdminInvoiceDetail {
  static readonly type = '[AdminInvoices] Clear invoice detail';
}

export class DismissAdminInvoiceListError {
  static readonly type = '[AdminInvoices] Dismiss list error';
}

export class DismissAdminInvoiceDetailError {
  static readonly type = '[AdminInvoices] Dismiss detail error';
}

/** All statuses selectable in the admin invoice-list filter. */
export const ADMIN_INVOICE_STATUS_OPTIONS: ReadonlyArray<{
  readonly value: CommissionInvoiceStatus | '';
  readonly label: string;
}> = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'in_review', label: 'In review' },
  { value: 'finalized', label: 'Finalized' },
  { value: 'paid', label: 'Paid' },
  { value: 'failed', label: 'Failed' },
  { value: 'disputed', label: 'Disputed' },
  { value: 'void', label: 'Void' },
];
