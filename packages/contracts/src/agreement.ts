/**
 * Platform agreement (clickwrap) + builder onboarding contracts (#722).
 *
 * The platform agreement is the commercial terms a builder org accepts
 * before any money action: the commission rate, the attribution window and
 * the contract-reporting duty. Acceptance is recorded append-only per
 * builder org; a new agreement version (API config
 * `PLATFORM_AGREEMENT_VERSION`) requires re-acceptance, and older rows are
 * kept but no longer count as "current".
 *
 * Only a builder org admin may accept. Members read the status and see
 * "Ask your admin to accept the agreement" (`canAccept: false`).
 */

/**
 * Error codes for the agreement gate. Every money action (record a signed
 * contract, mark won with contract details, card setup, invoice
 * finalisation) answers 409 `AGREEMENT_REQUIRED` while the org has no
 * acceptance of the current version.
 */
export const AgreementErrorCodes = {
  /** 409 — no acceptance of the current agreement version on record. */
  AGREEMENT_REQUIRED: 'AGREEMENT_REQUIRED',
  /** 403 — the caller is not an admin of the builder org (members can't accept). */
  AGREEMENT_ADMIN_REQUIRED: 'AGREEMENT_ADMIN_REQUIRED',
  /** 409 — the accepted version is not the current one (the page is stale). */
  AGREEMENT_VERSION_MISMATCH: 'AGREEMENT_VERSION_MISMATCH',
} as const;

export type AgreementErrorCode =
  (typeof AgreementErrorCodes)[keyof typeof AgreementErrorCodes];

/**
 * Review state of the served agreement text. `draft-pending-lawyer` until
 * counsel approves it; the legal gate blocks production deploys meanwhile.
 */
export type AgreementDocumentStatus = 'draft-pending-lawyer' | 'approved';

export interface AgreementDocumentSection {
  readonly heading: string;
  /** Plain-text paragraphs, in order. */
  readonly paragraphs: readonly string[];
}

/** The agreement text served with its version (rendered + downloadable). */
export interface AgreementDocument {
  /** Same as `AgreementStatus.version` — the version this text belongs to. */
  readonly version: string;
  readonly title: string;
  readonly status: AgreementDocumentStatus;
  readonly sections: readonly AgreementDocumentSection[];
}

/** Who accepted, as recorded at acceptance time. */
export interface AgreementAcceptedBy {
  /** Null when the user row was since deleted. */
  readonly userId: string | null;
  readonly name: string | null;
  readonly email: string | null;
}

/**
 * GET /api/v1/builder/agreement (and the response of the accept call).
 * Tenant-scoped to the session's active builder org.
 */
export interface AgreementStatus {
  /** The CURRENT agreement version (API config). */
  readonly version: string;
  /** True when the org has accepted `version`. */
  readonly current: boolean;
  /** ISO 8601 — when `version` was accepted; null when not accepted. */
  readonly acceptedAt: string | null;
  /** Who accepted `version`; null when not accepted. */
  readonly acceptedBy: AgreementAcceptedBy | null;
  /**
   * True when the caller may accept (builder org admin, not in view-as).
   * Members get false — the UI shows "Ask your admin to accept the
   * agreement".
   */
  readonly canAccept: boolean;
  /** The agreement text for `version`. */
  readonly document: AgreementDocument;
}

/** POST /api/v1/builder/agreement/accept body. */
export interface AcceptAgreementRequest {
  /** Must equal the current version; otherwise 409 AGREEMENT_VERSION_MISMATCH. */
  readonly version: string;
}

/** POST /api/v1/builder/agreement/accept response — the updated status. */
export type AcceptAgreementResponse = AgreementStatus;

/**
 * GET /api/v1/builder/onboarding — first-run checklist. Every flag is
 * computed server-side from real state.
 */
export interface BuilderOnboardingStatus {
  /** Current agreement version accepted by the org. */
  readonly agreementAccepted: boolean;
  /** Business name, display name, contact email and phone are all set. */
  readonly profileComplete: boolean;
  /** A card on file, or a deliberately chosen manual payment method. */
  readonly paymentMethodSet: boolean;
  /**
   * The embed is live: a lead captured through the embed, or an
   * `embed_loaded` analytics event, for this builder.
   */
  readonly embedVerified: boolean;
  /** More than one org member, or a pending (unexpired) invitation. */
  readonly teamInvited: boolean;
  /** True when every step above is done (the checklist can disappear). */
  readonly complete: boolean;
  /** Caller is an admin of the org (may accept the agreement, manage users). */
  readonly isAdmin: boolean;
  readonly agreement: AgreementStatus;
}

/**
 * Agreement block on the admin builder drawer
 * (GET /api/v1/admin/builders/{id} → `agreement`).
 */
export interface AdminBuilderAgreementSummary {
  /** The CURRENT agreement version (API config). */
  readonly currentVersion: string;
  /** True when the latest acceptance is of the current version. */
  readonly current: boolean;
  /** Version of the most recent acceptance (any version); null = never accepted. */
  readonly acceptedVersion: string | null;
  /** ISO 8601 — most recent acceptance; null = never accepted. */
  readonly acceptedAt: string | null;
  readonly acceptedBy: AgreementAcceptedBy | null;
}
