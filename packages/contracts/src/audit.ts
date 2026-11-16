/**
 * Audit log, finance export and builder activity contracts (#728).
 *
 * Shapes only: no logic, no math, no secrets. Every dollar figure is
 * integer cents computed by the API from stored invoice amounts — the
 * browser never sums money.
 *
 * - `GET /api/v1/admin/audit` → `AuditLogListResponse`
 * - `GET /api/v1/admin/billing/summary` → `FinanceSummary`
 * - `GET /api/v1/builder/activity` → `BuilderActivityResponse`
 * - `GET /api/v1/admin/billing/invoices/export.csv` and
 *   `GET /api/v1/billing/invoices/export.csv` → `text/csv` with the
 *   `INVOICE_EXPORT_COLUMNS` header row.
 */

/** Which table an audit entry came from. */
export type AuditLogSource = 'admin' | 'billing';

/** Entity kinds an audit entry can link to in the portal. */
export type AuditEntityType =
  | 'builder'
  | 'lead'
  | 'invoice'
  | 'user'
  | 'dispute'
  | 'api_key'
  | 'other';

/** One row in the merged admin + billing audit trail. */
export interface AuditLogEntry {
  /** `${source}:${uuid}` — unique across both sources. */
  readonly id: string;
  readonly source: AuditLogSource;
  /** ISO 8601 timestamp. */
  readonly occurredAt: string;
  /** Who did it; null for system/timer/webhook events. */
  readonly actorEmail: string | null;
  /** Raw action key, e.g. `admin_builder_commission_rate_changed`, `invoice.paid_manually`. */
  readonly action: string;
  /** Entity the entry is about, when known. */
  readonly entityType: AuditEntityType | null;
  readonly entityId: string | null;
  /** Builder tenant the entry belongs to, when known. */
  readonly tenantKey: string | null;
  /** True for view-as (impersonation) activity. */
  readonly impersonation: boolean;
  /**
   * Structured detail: the billing event payload, or the `key=value`
   * pairs of an admin audit row's detail (before/after values such as
   * `oldStatus`/`newStatus` or `from`/`to` live here).
   */
  readonly payload: Readonly<Record<string, unknown>> | null;
}

/** Query for `GET /api/v1/admin/audit` (all optional). */
export interface AuditLogListQuery {
  /** Exact actor email (case-insensitive). */
  readonly actor?: string;
  /** Action key prefix, e.g. `invoice.` or `user.invited`. */
  readonly action?: string;
  /** Applied server-side before paging: every page is full while matches remain. */
  readonly entityType?: AuditEntityType;
  readonly entityId?: string;
  /** ISO date/time, inclusive. */
  readonly from?: string;
  /** ISO date/time, exclusive. */
  readonly to?: string;
  /** Only view-as (impersonation) activity. */
  readonly impersonation?: boolean;
  readonly source?: AuditLogSource;
  /** 1–100, default 50. */
  readonly limit?: number;
  /** Opaque cursor from the previous page's `nextCursor`. */
  readonly cursor?: string;
}

/** Keyset-paginated, newest first. */
export interface AuditLogListResponse {
  readonly items: readonly AuditLogEntry[];
  /** Null when there are no more entries. */
  readonly nextCursor: string | null;
}

/** One builder's slice of the finance summary (integer cents). */
export interface FinanceSummaryBuilderRow {
  readonly tenantKey: string;
  readonly builderName: string | null;
  readonly invoiceCount: number;
  readonly invoicedCents: number;
  readonly collectedCents: number;
  readonly refundedCents: number;
  readonly outstandingCents: number;
  readonly taxCents: number;
}

/**
 * `GET /api/v1/admin/billing/summary?from&to`. Invoices are selected by
 * creation date in [from, to) — the same selection the invoice CSV uses,
 * so the CSV's totals match this panel to the cent.
 */
export interface FinanceSummary {
  /** ISO date/time, inclusive. */
  readonly from: string;
  /** ISO date/time, exclusive. */
  readonly to: string;
  readonly currency: string;
  readonly invoiceCount: number;
  /** Sum of invoice totals (commission + tax), void invoices excluded. */
  readonly invoicedCents: number;
  /** Sum of totals of invoices that were paid (incl. later refunded). */
  readonly collectedCents: number;
  /** Sum of refunded amounts. */
  readonly refundedCents: number;
  /** Unpaid, non-void invoice totals (draft, in review, finalized, failed, disputed). */
  readonly outstandingCents: number;
  /** Sum of tax on non-void invoices. */
  readonly taxCents: number;
  readonly byBuilder: readonly FinanceSummaryBuilderRow[];
}

/**
 * Invoice CSV header row, in order. Shared so the UI can describe the
 * export without hardcoding column names.
 */
export const INVOICE_EXPORT_COLUMNS = [
  'invoice_number',
  'created_at',
  'builder',
  'tenant_key',
  'lead_id',
  'contract_value',
  'commission_rate_percent',
  'commission',
  'tax',
  'total',
  'currency',
  'status',
  'payment_method',
  'paid_at',
  'refunded',
  'stripe_payment_intent_id',
] as const;

export type InvoiceExportColumn = (typeof INVOICE_EXPORT_COLUMNS)[number];

/** One builder activity row (`GET /api/v1/builder/activity`). */
export interface BuilderActivityEntry {
  readonly id: string;
  readonly occurredAt: string;
  /** Null for system events (e.g. an automatic charge). */
  readonly actorEmail: string | null;
  readonly action: string;
  readonly entityType: AuditEntityType | null;
  readonly entityId: string | null;
  readonly payload: Readonly<Record<string, unknown>> | null;
}

/**
 * Builder owner/admins see their whole team's activity (`scope: 'team'`);
 * other members see only their own (`scope: 'self'`). Owner decision
 * 2026-11-15 on #728.
 */
export interface BuilderActivityResponse {
  readonly scope: 'team' | 'self';
  readonly items: readonly BuilderActivityEntry[];
  readonly nextCursor: string | null;
}
