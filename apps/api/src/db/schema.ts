/**
 * Drizzle schema — M1 tables (BE1-001 / BE-3).
 *
 * - `estimates`: immutable estimate records. Insert-only — no update or
 *   delete path exists in the data layer. The full contract-shaped response
 *   (inputs, figures, rows) is stored as JSONB so any estimate can be
 *   re-rendered and audited against its pinned `cost_data_version`.
 * - `leads`: lead-gate captures. Email is stored lowercased + trimmed so
 *   dedup lookups are exact matches; `address_key` is denormalized from the
 *   estimate so the 90-day dedup is (email, address) — a fresh estimate for
 *   the same property is still the same lead. The dedup *window* itself is
 *   enforced in the service (a window can't be a static unique index).
 *
 * Money is never stored as float here — figures are integer-dollar ranges
 * inside the JSONB payload. All timestamps are timestamptz.
 *
 * Multi-tenant FKs (`tenant_id`) arrive with the tenants table (M4/BE-4);
 * `tenant_key` is captured verbatim on builder embeds so the data is not
 * lost in the meantime.
 */
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const estimates = pgTable(
  'estimates',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    /** Which engine branch produced the row: 'new_build' or 'renovation'. */
    projectType: text('project_type').notNull().default('new_build'),
    addressKey: text('address_key').notNull(),
    /** The contract `EstimateInputs` the estimate was computed from. */
    inputs: jsonb('inputs').notNull(),
    /** The contract `figures` ({ build, total, land } ranges). */
    figures: jsonb('figures').notNull(),
    /** Breakdown rows as returned by the engine. */
    rows: jsonb('rows').notNull(),
    costDataVersion: text('cost_data_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('estimates_address_key_idx').on(t.addressKey)],
);

export const leads = pgTable(
  'leads',
  {
    /** App-generated UUID (node:crypto). */
    id: uuid('id').primaryKey(),
    estimateId: uuid('estimate_id')
      .notNull()
      .references(() => estimates.id),
    /**
     * Denormalized from the estimate at capture. The 90-day dedup is
     * (email, addressKey) — the same household submitting a fresh estimate
     * for the same property is still the same lead.
     */
    addressKey: text('address_key').notNull(),
    /** Normalized: trimmed + lowercased before insert. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    timeline: text('timeline').notNull(),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    /** PIPEDA/CASL consent timestamp — set at capture. */
    consentTs: timestamp('consent_ts', { withTimezone: true }).notNull(),
    /** Present only on builder embeds; FK arrives with the tenants table. */
    tenantKey: text('tenant_key'),
    /** web | api | mcp — which surface captured the lead. */
    source: text('source').notNull().default('api'),
    /**
     * Anti-spam quarantine (HRD-03). Set when the honeypot field arrives
     * filled. Quarantined rows are excluded from the default lead listing
     * (see `LeadStore.listLeads`), admin counts, and Sheets sync — they
     * surface only in the admin quarantine tab.
     */
    quarantined: boolean('quarantined').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Lookup path for the 90-day dedup check: same normalized email +
    // same property, newest first. The window itself is enforced in the
    // service (a window can't be a static unique index).
    index('leads_address_email_created_idx').on(
      t.addressKey,
      t.email,
      t.createdAt,
    ),
  ],
);

/**
 * Magic-link bearer tokens (legal/02).
 *
 * The ONLY server-side bearer credential for consumer self-service until
 * BE-4's session model lands. One row is issued per lead capture (purpose
 * 'lead'); partner shares mint their own rows (purpose 'partner-share',
 * lead_id pointing at the owner's lead — see contracts/share.ts).
 *
 * Security: only the SHA-256 hex of the opaque token is stored — the raw
 * token is never persisted and never leaves the server except inside the
 * magic-link email itself. Privacy endpoints accept a token that is
 * unexpired and unrevoked; `used_at` is reserved for the future
 * verify→reportToken redemption flow and is ignored by bearer checks here.
 */
export const magicLinks = pgTable(
  'magic_links',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    /** Nullable so erasure can detach revoked links from deleted leads. */
    leadId: uuid('lead_id').references(() => leads.id, {
      onDelete: 'set null',
    }),
    /** 'lead' | 'partner-share' — extend as new issuance flows land. */
    purpose: text('purpose').notNull().default('lead'),
    /** SHA-256 hex of the opaque bearer token. Never the raw token. */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set by the future verify flow when the link is redeemed. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** Set on erasure (links stop working) — kept as anonymized audit. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('magic_links_lead_id_idx').on(t.leadId)],
);

/**
 * PIPEDA erasure requests (legal/02) — the two-step human-confirmed flow.
 *
 * `emailHash` (SHA-256 of the normalized email) keeps the audit trail
 * joinable after the leads rows — and their PII — are deleted. Statuses:
 * 'requested' → 'completed' | 'blocked'.
 */
export const erasureRequests = pgTable(
  'erasure_requests',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    /** The requesting lead; SET NULL when erasure deletes the lead rows. */
    leadId: uuid('lead_id').references(() => leads.id, {
      onDelete: 'set null',
    }),
    /** SHA-256 hex of the normalized email — audit without PII. */
    emailHash: text('email_hash').notNull(),
    /** 'requested' | 'blocked' | 'completed'. */
    status: text('status').notNull(),
    /** Snapshot of the blockers that stopped a confirm attempt (JSON). */
    blockers: jsonb('blockers'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => [index('erasure_requests_email_hash_idx').on(t.emailHash)],
);

/**
 * Privacy audit log (legal/02).
 *
 * Every export/erasure request — granted AND denied — lands here. Columns
 * are deliberately PII-free: `leadId` (a UUID, not an email) plus an action
 * and a short detail string. Token values, hashes, emails and names must
 * never be written here — enforced by code review, not the schema.
 */
export const privacyAuditLog = pgTable(
  'privacy_audit_log',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    /** Null when authentication failed (no identity to attribute). */
    leadId: uuid('lead_id'),
    /** 'export' | 'export.denied' | 'erase.request' | 'erase.confirm' |
     *  'erase.confirm.denied' | 'erase.blocked' */
    action: text('action').notNull(),
    /** Short machine-readable detail — never PII, never token material. */
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('privacy_audit_log_lead_id_idx').on(t.leadId)],
);
