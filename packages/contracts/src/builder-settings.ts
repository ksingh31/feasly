/**
 * Builder Settings contracts (#870 — API half of #724).
 *
 * The builder portal's own Settings area: profile & branding, the embed
 * install snippet with a per-origin install check, and "Request a change"
 * for embed origins.
 *
 * Owner decisions (2026-11-15, #724):
 * - Builder owners (`builder_admin`) edit display name, contact phone/email,
 *   logo URL and accent colour. Members read only.
 * - Allowed embed origins stay staff-controlled for the pilot: builders see
 *   them read-only and file an origin-change request, which opens an admin
 *   task.
 * - Support is email only, to a configured address, promising a reply
 *   "within 1 business day".
 *
 * Commission rate, plan and status are never part of these payloads.
 */

/** The builder-editable profile and branding. */
export interface BuilderProfile {
  /** The builder's tenant key (read-only). */
  readonly tenantKey: string;
  /** Legal/business name (read-only — staff-controlled). */
  readonly businessName: string;
  readonly displayName: string;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  /** https URL of the builder's hosted logo; null = Feasly wordmark. */
  readonly logoUrl: string | null;
  /** `#rrggbb`; null = the embed's default accent. */
  readonly accentColor: string | null;
  readonly updatedAt: string;
}

/** Where builders get help (from API config, never hardcoded in the UI). */
export interface BuilderSupportContact {
  readonly channel: 'email';
  readonly email: string;
  /** Promised response time copy, e.g. "within 1 business day". */
  readonly responseTime: string;
}

export interface BuilderProfileResponse {
  readonly profile: BuilderProfile;
  /** True when the caller may change the profile (org owners only). */
  readonly canEdit: boolean;
  readonly support: BuilderSupportContact;
}

/**
 * `PUT /api/v1/builder/profile` body. Partial: omitted = unchanged; null
 * (or '') clears an optional field. At least one field is required.
 */
export interface BuilderProfileUpdateBody {
  readonly displayName?: string;
  readonly contactEmail?: string | null;
  readonly contactPhone?: string | null;
  readonly logoUrl?: string | null;
  readonly accentColor?: string | null;
}

/** Install status of one allowed origin. */
export interface BuilderEmbedOriginStatus {
  readonly origin: string;
  /** Last `embed_loaded` event from this origin (server time), or null. */
  readonly lastSeenAt: string | null;
  /** True when the widget loaded on this origin inside the live window. */
  readonly loadedRecently: boolean;
}

export type BuilderOriginRequestStatus = 'open' | 'done' | 'dismissed';

/** One "change my allowed origins" request (an admin task). */
export interface BuilderOriginRequest {
  readonly id: string;
  readonly status: BuilderOriginRequestStatus;
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly note: string | null;
  readonly createdAt: string;
}

/** `GET /api/v1/builder/embed` — snippet data + install verification. */
export interface BuilderEmbedResponse {
  readonly tenantKey: string;
  /** Absolute URL of the embed loader script. */
  readonly loaderUrl: string;
  /** The exact install snippet for this builder. */
  readonly snippet: string;
  /** Allowed origins (read-only for builders) with per-origin status. */
  readonly origins: readonly BuilderEmbedOriginStatus[];
  /** The "loaded recently" window, in days. */
  readonly liveWindowDays: number;
  /** Most recent load across all allowed origins, or null. */
  readonly lastSeenAt: string | null;
  /** Origin-change requests still waiting for Feasly staff. */
  readonly openRequests: readonly BuilderOriginRequest[];
}

/** `POST /api/v1/builder/embed/origin-requests` body. */
export interface BuilderOriginRequestBody {
  /** Origins to allow, e.g. `https://staging.example.com`. */
  readonly add?: readonly string[];
  /** Currently allowed origins to remove. */
  readonly remove?: readonly string[];
  /** Optional context for Feasly staff (max 500 characters). */
  readonly note?: string;
}

export interface BuilderOriginRequestResponse {
  readonly request: BuilderOriginRequest;
  /** False when an identical open request already existed (no new task). */
  readonly created: boolean;
}
