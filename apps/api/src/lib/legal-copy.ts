/**
 * Draft legal copy for the PIPEDA flows (legal/02).
 *
 * Everything here is DRAFT until the lawyer reviews and approves it —
 * see docs/legal/approved-copy.md. Each constant carries the draft marker
 * structurally (`status: 'draft-pending-lawyer'`) so the legal-gate story
 * (hardening/05) can diff-test these against the approved copy later.
 * Pure data: no I/O, no clock, no env.
 */

/** Marker proving a copy block is still the unreviewed draft. */
export const LEGAL_REVIEW_PENDING = 'draft-pending-lawyer' as const;

/** Consequences statement returned when an erasure request is created. */
export interface ErasureConsequences {
  readonly status: typeof LEGAL_REVIEW_PENDING;
  readonly statements: readonly string[];
}

export const ERASURE_CONSEQUENCES_DRAFT: ErasureConsequences = {
  status: LEGAL_REVIEW_PENDING,
  statements: [
    'Your report links will stop working immediately.',
    'Links you shared with a partner will be revoked.',
    'Your name, email address and phone number will be permanently deleted from our systems.',
    'Anonymized estimate figures may be retained for cost-model calibration. They are detached from your identity and cannot be linked back to you.',
    'If you change your mind, submit a new estimate — a fresh report link will be issued.',
  ],
};

/** One row of the data-retention schedule. */
export interface RetentionRule {
  readonly record: string;
  readonly retention: string;
  readonly status: typeof LEGAL_REVIEW_PENDING;
}

/**
 * Draft retention schedule. The lawyer confirms (or rewrites) every row;
 * the diff test in test/privacy-legal-copy.test.ts pins the attach point.
 */
export const RETENTION_RULES_DRAFT: readonly RetentionRule[] = [
  {
    record: 'leads (name, email, phone, consent)',
    retention: 'Deleted when an erasure request is confirmed. Otherwise retained while the business relationship is active.',
    status: LEGAL_REVIEW_PENDING,
  },
  {
    record: 'estimates (anonymized snapshots)',
    retention: 'Retained indefinitely, detached from identity, for cost-model calibration.',
    status: LEGAL_REVIEW_PENDING,
  },
  {
    record: 'magic_links',
    retention: 'Revoked when an erasure request is confirmed. Token hashes are retained for audit; raw tokens are never stored.',
    status: LEGAL_REVIEW_PENDING,
  },
  {
    record: 'erasure_requests',
    retention: 'Retained as proof that the request was honored.',
    status: LEGAL_REVIEW_PENDING,
  },
  {
    record: 'privacy_audit_log',
    retention: 'Retained for security and compliance auditing. Contains no emails, names, or token material.',
    status: LEGAL_REVIEW_PENDING,
  },
];

/** Short retention notice embedded in the export payload. */
export const EXPORT_RETENTION_NOTICE_DRAFT: string =
  'Draft — pending lawyer review. Data-retention rules have not been legally approved yet; see docs/legal/approved-copy.md.';
