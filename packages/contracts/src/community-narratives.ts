/**
 * Monthly community narrative admin contracts (#759).
 *
 * Backend: `GET /api/v1/admin/community-narratives` (each community's
 * latest period, status, and generated date) and
 * `POST /api/v1/admin/community-narratives/regenerate` (regenerate one
 * community or all; audit-logged). Both admin-gated.
 *
 * Wire format is snake_case; timestamps are ISO 8601 strings.
 */

/** Latest-attempt status. 'missing' = never generated for this community. */
export type AdminCommunityNarrativeStatus = 'succeeded' | 'failed' | 'stale' | 'missing';

export interface AdminCommunityNarrativeEntry {
  readonly community_slug: string;
  readonly community_name: string;
  /** `YYYY-MM` the narrative is served for; null when never attempted. */
  readonly period: string | null;
  readonly status: AdminCommunityNarrativeStatus;
  /** ISO 8601 — when the stored text was generated; null when none. */
  readonly generated_at: string | null;
  readonly attempts: number;
  /** Sanitized error from the latest failed attempt (no secrets, no PII). */
  readonly last_error: string | null;
}

/** `GET /api/v1/admin/community-narratives` response. */
export interface AdminCommunityNarrativesResponse {
  readonly communities: readonly AdminCommunityNarrativeEntry[];
}

/** `POST /api/v1/admin/community-narratives/regenerate` body. Omit the slug for all. */
export interface AdminCommunityNarrativeRegenerateRequest {
  readonly community_slug?: string;
}

/** `POST /api/v1/admin/community-narratives/regenerate` response. */
export interface AdminCommunityNarrativeRegenerateResponse {
  readonly scope: 'one' | 'all';
  /** `YYYY-MM` period that was regenerated. */
  readonly period: string;
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  /** Communities left for the next daily tick (time budget / cost guard). */
  readonly deferred: number;
}
