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

/**
 * GET /api/v1/privacy/export — everything Feasly holds about the bearer
 * identity. `reportShares` / `callbackRequests` are empty arrays until their
 * server-side stores land (documented in the story); they are part of the
 * shape now so clients don't need a breaking change later.
 */
export interface PrivacyExportResponse {
  readonly exportedAt: string;
  readonly email: string;
  readonly leads: readonly PrivacyLeadExport[];
  readonly estimates: readonly PrivacyEstimateExport[];
  readonly magicLinks: readonly PrivacyMagicLinkExport[];
  readonly reportShares: readonly unknown[];
  readonly callbackRequests: readonly unknown[];
  readonly erasureRequests: readonly PrivacyErasureRequestExport[];
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
}

/** POST /api/v1/privacy/erase-requests/{id}/confirm — executes erasure. */
export interface ErasureConfirmResponse {
  readonly requestId: string;
  readonly status: 'completed';
  readonly confirmedAt: string;
  readonly revokedMagicLinks: number;
  readonly deletedLeads: number;
}
