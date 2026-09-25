/**
 * Admin leads-explorer contracts (admin/02).
 *
 * Backend: `GET /api/v1/admin/leads` (list w/ filters + cursor pagination),
 * `GET /api/v1/admin/leads/{id}` (detail), `POST /api/v1/admin/leads/{id}/notes`
 * (append-only), `PATCH /api/v1/admin/leads/{id}/status` (pipeline transitions),
 * `GET /api/v1/admin/leads/export.csv` (CSV export of the filtered set).
 *
 * All amounts are integer cents. The UI formats to CAD dollars — no float
 * math in display (AC2).
 */

/** Pipeline statuses. Matches the `leads.status` column values. */
export type AdminLeadStatus = 'new' | 'contacted' | 'quoting' | 'won' | 'lost';

/** Lead capture surfaces. Matches the `leads.source` column values. */
export type AdminLeadSource = 'web' | 'embed' | 'api' | 'mcp';

/** Query filters for `GET /api/v1/admin/leads`. All optional; combine with AND. */
export interface AdminLeadFilters {
  /** Minimum lead score (inclusive). */
  readonly minScore?: number;
  /** Maximum lead score (inclusive). */
  readonly maxScore?: number;
  /** Pipeline status filter. */
  readonly status?: AdminLeadStatus;
  /** Capture surface filter. */
  readonly source?: AdminLeadSource;
  /** Project type filter (`new_build` | `renovation` — from the estimate). */
  readonly projectType?: string;
  /** Tenant key filter (builder embeds). */
  readonly tenantId?: string;
  /** Created at/after (ISO 8601). */
  readonly createdAfter?: string;
  /** Created before (ISO 8601). */
  readonly createdBefore?: string;
  /** Free-text search: matches name, email, or address_key (case-insensitive). */
  readonly search?: string;
  /**
   * Include quarantined (honeypot) rows. Default false — quarantined rows
   * surface only in the quarantine tab.
   */
  readonly includeQuarantined?: boolean;
  /**
   * Include sandbox rows (API-014). Default false — sandbox rows are badged
   * "Sandbox" and excluded from counts by default.
   */
  readonly includeSandbox?: boolean;
}

/** One row in the leads table. */
export interface AdminLeadListItem {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly addressKey: string;
  readonly leadScore: number;
  readonly status: AdminLeadStatus;
  readonly source: string;
  readonly projectType: string;
  readonly tenantKey: string | null;
  readonly timeline: string;
  /** True when created via a sandbox API key — UI badges "Sandbox". */
  readonly sandbox: boolean;
  readonly createdAt: string;
}

/** Paginated list response. Cursor is opaque; null when no more pages. */
export interface AdminLeadListResponse {
  readonly leads: readonly AdminLeadListItem[];
  /** Opaque cursor for the next page; null when this is the last page. */
  readonly nextCursor: string | null;
  /** Total matching the filters (for the UI count display). */
  readonly totalCount: number;
}

/** Estimate summary embedded in the lead detail. Amounts in integer cents. */
export interface AdminLeadEstimateSummary {
  readonly estimateId: string;
  readonly addressKey: string;
  readonly projectType: string;
  /** Living area sqft (from estimate inputs, when present). */
  readonly sqft: number | null;
  /** Selected finish tier (display-only). */
  readonly tier: string | null;
  /** Total range in cents: [low, high]. */
  readonly totalRangeCents: readonly [number, number];
  /** Build range in cents: [low, high]. */
  readonly buildRangeCents: readonly [number, number];
  /** Land (city-assessed) in cents — a single fixed number. */
  readonly landCents: number;
  readonly createdAt: string;
}

/** Magic-link status for the lead's report access. */
export type AdminLeadMagicLinkStatus = 'sent' | 'used' | 'expired' | 'none';

/** Full lead detail for the admin panel. */
export interface AdminLeadDetail extends AdminLeadListItem {
  readonly phone: string | null;
  readonly marketingConsent: boolean;
  readonly consentTs: string;
  readonly quarantined: boolean;
  readonly unsubscribedAt: string | null;
  readonly nudgeSentAt: string | null;
  readonly estimate: AdminLeadEstimateSummary | null;
  readonly magicLinkStatus: AdminLeadMagicLinkStatus;
  /** Sheets sync timestamp (from the sync worker; null when never synced). */
  readonly sheetsSyncedAt: string | null;
  /** Number of persisted report snapshots for this lead. */
  readonly snapshotCount: number;
  readonly notes: readonly AdminLeadNote[];
  readonly statusHistory: readonly AdminLeadStatusHistoryEntry[];
}

/** One append-only note. */
export interface AdminLeadNote {
  readonly id: string;
  readonly note: string;
  readonly createdAt: string;
}

/** One status transition. */
export interface AdminLeadStatusHistoryEntry {
  readonly oldStatus: AdminLeadStatus | null;
  readonly newStatus: AdminLeadStatus;
  readonly changedBy: string | null;
  readonly changedAt: string;
}

/** Body for `POST /api/v1/admin/leads/{id}/notes`. */
export interface AdminLeadNoteRequest {
  readonly note: string;
}

/** Body for `PATCH /api/v1/admin/leads/{id}/status`. */
export interface AdminLeadStatusRequest {
  readonly status: AdminLeadStatus;
}

/** Response for note creation and status updates. */
export interface AdminLeadMutationResponse {
  readonly ok: true;
}
