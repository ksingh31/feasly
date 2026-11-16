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
    record: 'waitlist_signups (email, topic, consent)',
    retention: 'Deleted when an erasure request is confirmed. Otherwise retained until the topic launches and the launch email is sent.',
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

/**
 * Version tag of the waitlist consent wording (#520, owner decision
 * 2026-11-15) stored in `waitlist_signups.consent_version`. Bump it when the
 * wording in docs/legal/approved-copy.md "CASL waitlist consent wording"
 * (and the web `copy.waitlist.consentLabel`) changes.
 */
export const WAITLIST_CONSENT_VERSION = 'waitlist-2026-11-15-draft' as const;

/**
 * Version tag of the agent-API lead consent attestation (#738, owner
 * decision 2026-11-15). An API caller submitting a lead (REST
 * `POST /api/v1/leads` with a Bearer key, or the MCP `submit_lead` tool)
 * must send `consent: true` plus `consentVersion` equal to this tag; the
 * lead row stores the tag, the attesting key and the time. Bump it when the
 * wording in docs/legal/approved-copy.md "API lead consent attestation"
 * changes — callers then have to re-attest to the new wording.
 */
export const API_LEAD_CONSENT_VERSION = 'api-lead-2026-11-15-draft' as const;

/** The attestation wording an API caller agrees to (draft, pending lawyer). */
export const API_LEAD_CONSENT_ATTESTATION_DRAFT = {
  status: LEGAL_REVIEW_PENDING,
  version: API_LEAD_CONSENT_VERSION,
  text:
    'I confirm that the person named in this lead asked to be contacted about their estimate, ' +
    'agreed that Feasly and builders associated with Feasly may contact them about it, ' +
    'and was told they can opt out anytime.',
} as const;

/** Short retention notice embedded in the export payload. */
export const EXPORT_RETENTION_NOTICE_DRAFT: string =
  'Draft — pending lawyer review. Data-retention rules have not been legally approved yet; see docs/legal/approved-copy.md.';

/**
 * Default version tag of the platform agreement (#722). The CURRENT version
 * is `config.agreement.version` (env `PLATFORM_AGREEMENT_VERSION`), which
 * defaults to this. Bump both together whenever the text below changes:
 * builder orgs then have to accept again (older acceptances are kept but no
 * longer count as current).
 */
export const PLATFORM_AGREEMENT_VERSION = '2026-11-draft-1' as const;

/** One section of the platform agreement text. */
export interface PlatformAgreementSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

/** The platform agreement text served by GET /api/v1/builder/agreement. */
export interface PlatformAgreementText {
  readonly status: typeof LEGAL_REVIEW_PENDING;
  readonly title: string;
  readonly sections: readonly PlatformAgreementSection[];
}

/**
 * DRAFT platform agreement (#722, owner decision 2026-11-15: copy is
 * draft-pending-counsel). Neutral summary of the commercial terms so the
 * clickwrap mechanism can ship; counsel replaces the wording later (swap
 * the text, bump PLATFORM_AGREEMENT_VERSION, drop the marker). The
 * structural `status` marker keeps the legal gate blocking production.
 */
export const PLATFORM_AGREEMENT_DRAFT: PlatformAgreementText = {
  status: LEGAL_REVIEW_PENDING,
  title: 'Feasly platform agreement (draft)',
  sections: [
    {
      heading: 'About this agreement',
      paragraphs: [
        'This draft has not been reviewed by counsel yet. It summarises the commercial terms between Feasly and your organisation for leads introduced through Feasly.',
        'An administrator of your organisation accepts it on behalf of the organisation. If the agreement changes, an administrator will be asked to accept the new version.',
      ],
    },
    {
      heading: 'Commission',
      paragraphs: [
        'When your organisation signs a construction contract with a homeowner Feasly introduced, Feasly charges a commission on the signed construction contract value, excluding land.',
        'The default commission rate is 1%. A different rate may be agreed for your organisation; the rate shown in your portal is the one that applies, and a rate change affects future invoices only.',
      ],
    },
    {
      heading: 'Attribution window',
      paragraphs: [
        'A homeowner counts as introduced by Feasly for 12 months from the date of the introduction. A contract signed with that homeowner within those 12 months is subject to the commission.',
        'If your organisation already had a relationship with the homeowner before the introduction, you can show this and the lead is excluded.',
      ],
    },
    {
      heading: 'Reporting duty',
      paragraphs: [
        'Your organisation reports each signed contract for an introduced homeowner in the Feasly portal within 14 days of signing, with the contract value excluding land and the signing date.',
      ],
    },
    {
      heading: 'Invoices and charges',
      paragraphs: [
        'We charge your card 7 days after the invoice is issued. You can question it any time before then.',
        'You can choose a manual payment method instead of a card; manual invoices are not charged automatically.',
      ],
    },
  ],
};
