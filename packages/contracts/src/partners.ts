/**
 * Builder partner disclosure contracts (issue #888, split from #847).
 *
 * Feasly discloses which builder companies receive leads from Feasly's own
 * site (owner decision 2026-11-15). The partner list is DATA, not copy:
 * admins add / deactivate / reorder partners and every disclosure location
 * renders from `GET /api/v1/partners` — no deploy, no copy change.
 *
 * Company names only, never individuals. No contact details (email/phone)
 * appear on the public shape.
 */

/** One partner as shown publicly (active partners only). */
export interface BuilderPartner {
  readonly id: string;
  /** Company name shown in the disclosure, e.g. "Elite Craft Builders". */
  readonly name: string;
  /** Hosted logo URL, or null (the UI shows the name only). */
  readonly logoUrl: string | null;
  /** Company website (https), or null. */
  readonly websiteUrl: string | null;
  /** Short description / community focus, or null. */
  readonly description: string | null;
}

/** `GET /api/v1/partners` — active partners in display order. */
export interface BuilderPartnerListResponse {
  readonly partners: readonly BuilderPartner[];
}

/** One partner as the admin console sees it (active and inactive). */
export interface AdminBuilderPartner extends BuilderPartner {
  /** Linked `builders` row (the builder that receives the leads), or null. */
  readonly builderId: string | null;
  /** Ascending sort key for the public list (ties break by name). */
  readonly displayOrder: number;
  /** Inactive partners are hidden from the public list. */
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `GET /api/v1/admin/partners` — every partner, display order. */
export interface AdminBuilderPartnerListResponse {
  readonly partners: readonly AdminBuilderPartner[];
}

/** `POST /api/v1/admin/partners`. */
export interface BuilderPartnerCreateBody {
  readonly name: string;
  readonly logoUrl?: string | null;
  readonly websiteUrl?: string | null;
  readonly description?: string | null;
  readonly builderId?: string | null;
  /** Defaults to after the current last partner. */
  readonly displayOrder?: number;
  /** Defaults to true. */
  readonly active?: boolean;
}

/**
 * `PATCH /api/v1/admin/partners/{id}` — every field optional; omitted =
 * unchanged, explicit null clears a nullable field. Deactivate with
 * `active: false`; reorder with `displayOrder`.
 */
export interface BuilderPartnerUpdateBody {
  readonly name?: string;
  readonly logoUrl?: string | null;
  readonly websiteUrl?: string | null;
  readonly description?: string | null;
  readonly builderId?: string | null;
  readonly displayOrder?: number;
  readonly active?: boolean;
}
