/**
 * Google Sheets client interface (admin/04).
 *
 * The interface is what `SheetsSyncService` depends on; unit tests fake it.
 * The Google Sheets API implementation is constructed once in composition.ts.
 * Credentials come from config (service-account reference in Key Vault) —
 * never hardcoded, never in the repo.
 */

/** One row of lead data for the Sheet. Column order matches the header row. */
export interface SheetLeadRow {
  readonly leadId: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly timeline: string;
  readonly leadScore: number;
  readonly status: string;
  readonly projectType: string;
  readonly address: string;
  readonly sqft: number | null;
  readonly tier: string;
  readonly rangeLow: number | null;
  readonly rangeHigh: number | null;
  readonly consentTs: string;
  readonly marketingConsent: boolean;
  readonly tenant: string;
  readonly source: string;
  readonly createdAt: string;
}

export interface SheetsClient {
  /**
   * Upsert rows into the Sheet, keyed by lead ID (column A).
   * New lead IDs are appended; existing IDs have their row replaced.
   * Postgres is the source of truth — the Sheet is a read-only mirror.
   */
  upsertRows(rows: readonly SheetLeadRow[]): Promise<void>;
  /**
   * Check that the Sheet is reachable and the service account has access.
   * Used for the fail-closed check at worker startup.
   */
  checkAccess(): Promise<void>;
}
