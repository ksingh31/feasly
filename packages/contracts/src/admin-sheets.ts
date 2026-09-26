/**
 * Sheets sync ops contracts (admin/05).
 *
 * Backend: `GET /api/v1/admin/ops/sheets-status` (worker health at a
 * glance) and `POST /api/v1/admin/ops/sheets-sync-now` (admin-triggered
 * manual run, audit-logged). Both are admin-gated.
 *
 * Wire format is snake_case (matches the API contract); timestamps are
 * ISO 8601 strings.
 */

/** Badge states for the Sheets sync ops panel (admin/05 AC2). */
export type SheetsSyncBadge = 'healthy' | 'lagging' | 'failing';

/**
 * One recent failure entry. `error` is the sanitized worker error text —
 * never credentials, never PII (sanitized server-side before storage).
 */
export interface SheetsSyncFailure {
  /** ISO 8601 — when the failed run finished. */
  readonly at: string;
  /** Sanitized error text. */
  readonly error: string;
}

/**
 * `GET /api/v1/admin/ops/sheets-status` response.
 *
 * Badge logic (admin/05 AC2, documented on the panel):
 * - "failing" when `consecutive_failures >= 3`
 * - "lagging" when `lagging` is true (no successful sync in the last 2h,
 *   or attempted but never succeeded)
 * - "healthy" otherwise
 */
export interface SheetsSyncStatusResponse {
  /** ISO 8601 — newest run's start, or null when no run recorded yet. */
  readonly last_run_at: string | null;
  /** ISO 8601 — newest successful run's finish, or null if never succeeded. */
  readonly last_success_at: string | null;
  /** Sum of `synced_count` over all successful runs (all time). */
  readonly rows_synced_total: number;
  /**
   * Leads with `sheets_synced_at IS NULL` (spam-quarantined rows excluded —
   * they never sync). Reconciles exactly with that DB predicate.
   */
  readonly pending_count: number;
  /** Trailing failed runs since the last success (DB-derived, not in-memory). */
  readonly consecutive_failures: number;
  /** True when the sync is failing (≥3 consecutive) or lagging (no success in 2h). */
  readonly lagging: boolean;
  /** True when a run is currently in flight (started < 30 min ago). */
  readonly run_in_flight: boolean;
  /** Whether Sheets is configured (fail-closed when not). */
  readonly sheets_configured: boolean;
  /** Newest-first sanitized failure entries (up to 5). */
  readonly recent_failures: readonly SheetsSyncFailure[];
}

/**
 * `POST /api/v1/admin/ops/sheets-sync-now` response.
 *
 * Triggers exactly one worker run inline and returns its outcome.
 * Audit-logged server-side with the triggering admin's email.
 */
export interface SheetsSyncNowResponse {
  /** Leads upserted to the Sheet in this run. */
  readonly synced: number;
  /** Candidates skipped (bad rows — retried on the next run). */
  readonly skipped: number;
  /** True when Sheets is not configured (fail-closed, nothing synced). */
  readonly disabled: boolean;
  /** ISO 8601 — when the manual run was triggered. */
  readonly triggered_at: string;
}
