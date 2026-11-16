/**
 * PIPEDA privacy contracts (legal/02).
 *
 * Self-service data export + erasure for the magic-link bearer identity.
 * The export payload deliberately contains the subject's own PII — it IS
 * their data. Token hashes are NEVER included (acceptance criterion 1):
 * `magicLinks` carries lifecycle metadata only.
 */

/** One lead row belonging to the export subject. */
export interface PrivacyLeadExport {
  readonly id: string;
  readonly estimateId: string;
  readonly addressKey: string;
  readonly email: string;
  readonly name: string;
  readonly phone: string | null;
  readonly timeline: string;
  readonly marketingConsent: boolean;
  /** PIPEDA/CASL consent timestamp captured at the lead gate. */
  readonly consentTs: string;
  readonly tenantKey: string | null;
  readonly source: string;
  readonly createdAt: string;
}

/** One immutable estimate snapshot attached to the subject's leads. */
export interface PrivacyEstimateExport {
  readonly id: string;
  readonly addressKey: string;
  readonly inputs: unknown;
  readonly figures: unknown;
  readonly rows: unknown;
  readonly costDataVersion: string;
  readonly createdAt: string;
}

/**
 * Magic-link lifecycle metadata. The token hash is intentionally absent —
 * hashes never leave the server in an export.
 */
export interface PrivacyMagicLinkExport {
  readonly id: string;
  readonly leadId: string | null;
  readonly purpose: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly revokedAt: string | null;
}

/** Erasure requests filed by the subject (audit trail survives erasure). */
export interface PrivacyErasureRequestExport {
  readonly id: string;
  readonly status: 'requested' | 'blocked' | 'completed';
  readonly createdAt: string;
  readonly confirmedAt: string | null;
}

/** One waitlist signup (#520) held under the subject's email. */
export interface PrivacyWaitlistSignupExport {
  readonly topic: string;
  readonly createdAt: string;
  /** CASL consent timestamp captured with the signup. */
  readonly consentTs: string;
  /** Which consent wording the person agreed to (null = unknown). */
  readonly consentVersion: string | null;
}

/** One "call me back" request (#639) attached to one of the subject's leads. */
export interface PrivacyCallbackRequestExport {
  readonly id: string;
  readonly leadId: string;
  readonly name: string;
  readonly phone: string;
  /** 'morning' | 'afternoon' | 'evening'. */
  readonly window: string;
  readonly status: string;
  readonly createdAt: string;
}

/**
 * GET /api/v1/privacy/export — everything Feasly holds about the bearer
 * identity. `reportShares` is an empty array until its
 * server-side store lands (documented in the story); they are part of the
 * shape now so clients don't need a breaking change later.
 */
export interface PrivacyExportResponse {
  readonly exportedAt: string;
  readonly email: string;
  readonly leads: readonly PrivacyLeadExport[];
  readonly estimates: readonly PrivacyEstimateExport[];
  readonly magicLinks: readonly PrivacyMagicLinkExport[];
  readonly reportShares: readonly unknown[];
  /** #639: callback requests attached to the subject's leads. */
  readonly callbackRequests: readonly PrivacyCallbackRequestExport[];
  readonly erasureRequests: readonly PrivacyErasureRequestExport[];
  /** #520: waitlist signups under the subject's email. */
  readonly waitlistSignups?: readonly PrivacyWaitlistSignupExport[];
  /** Draft until the lawyer approves — see docs/legal/approved-copy.md. */
  readonly retentionNotice: string;
}

/**
 * POST /api/v1/privacy/erase-requests — creates the request and returns the
 * consequences statement. Nothing is deleted until the confirm step.
 */
export interface ErasureRequestResponse {
  readonly requestId: string;
  readonly status: 'requested';
  /** Draft copy until the lawyer approves. */
  readonly consequences: readonly string[];
  readonly createdAt: string;
  /**
   * #806: whether a confirmation email (link to
   * `/privacy/confirm/{requestId}#token=…`) was sent by THIS call. False on a
   * duplicate request inside the resend cooldown, when the hourly send budget
   * is spent, or when delivery failed — the request itself is still recorded.
   */
  readonly confirmationEmailSent: boolean;
}

/** POST /api/v1/privacy/erase-requests/{id}/confirm — executes erasure. */
export interface ErasureConfirmResponse {
  readonly requestId: string;
  readonly status: 'completed';
  readonly confirmedAt: string;
  readonly revokedMagicLinks: number;
  readonly deletedLeads: number;
}
