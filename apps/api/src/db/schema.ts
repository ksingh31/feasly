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
  integer,
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
    /**
     * Heuristic lead score (consumer/02, `src/lib/lead-score.ts` v1).
     * Recomputed on every dedupe update from the latest submission.
     */
    leadScore: integer('lead_score').notNull().default(0),
    /**
     * Pipeline status. Advanced by the admin UI (admin/02); the consumer
     * dedupe update never touches it. Values: new | contacted | quoting |
     * won | lost.
     */
    status: text('status').notNull().default('new'),
    /**
     * CASL opt-out (email/03). Set when the homeowner completes the
     * one-click unsubscribe flow; NULL means still subscribed. Nudge and
     * marketing emails are suppressed while set; transactional magic-link
     * emails still send (they are requested content, not marketing).
     */
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    /** email/02: exactly-once guard for the 24h nudge; null = not yet sent. */
    nudgeSentAt: timestamp('nudge_sent_at', { withTimezone: true }),
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
 * Append-only lead notes (consumer/02; admin/02 adds the HTTP endpoints).
 *
 * Notes are history, not fields: the consumer dedupe update (90-day
 * repeat-estimate rule) never modifies or deletes them — it only rewrites
 * the scalar columns on `leads`. Tests assert this explicitly.
 */
export const leadNotes = pgTable(
  'lead_notes',
  {
    id: uuid('id').primaryKey(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    note: text('note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('lead_notes_lead_id_idx').on(t.leadId)],
);

/**
 * Lead status history (consumer/02; admin/02 adds the HTTP endpoints).
 *
 * Every status transition appends a row. Like notes, this is history the
 * dedupe update never touches.
 */
export const leadStatusHistory = pgTable(
  'lead_status_history',
  {
    id: uuid('id').primaryKey(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    oldStatus: text('old_status'),
    newStatus: text('new_status').notNull(),
    /** Admin email or 'system'. Never PII beyond what's already on the lead. */
    changedBy: text('changed_by'),
    changedAt: timestamp('changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('lead_status_history_lead_id_idx').on(t.leadId)],
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

/**
 * Community stats (neighbourhood/01).
 *
 * One row per Calgary community: real aggregates from the City of Calgary
 * property assessment dataset (Socrata `4bsw-nn7w`). Cache-first: the API
 * never calls Socrata per-request; rows are written by the seed script
 * (`tools/seed-community-stats.mjs`) and refreshed by the monthly timer
 * (`neighbourhood/05-community-stats-refresh.md`).
 *
 * Money is an integer (whole CAD dollars, City-assessed value — NOT market
 * value). `slug` is derived from the community name (lowercase, hyphenated)
 * and is the API lookup key.
 */
export const communityStats = pgTable('community_stats', {
  /** URL-safe community key, e.g. 'mount-pleasant'. */
  slug: text('slug').primaryKey(),
  /** Display name as published by the City, e.g. 'Mount Pleasant'. */
  name: text('name').notNull(),
  /** Average City-assessed value, whole CAD dollars (not market value). */
  avgAssessedValue: integer('avg_assessed_value').notNull(),
  /** Number of assessment records behind the averages. */
  assessmentCount: integer('assessment_count').notNull(),
  /** Average lot size in square feet; null when the dataset lacks it. */
  avgLotSqft: integer('avg_lot_sqft'),
  /** When the row was last computed — drives the API's `stale` flag. */
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull(),
});

/**
 * Builder tenants (EMB-02). The DB row is the FALLBACK for the repo JSON
 * (`config/builders/{tenantKey}.json`), which is read first — the JSON is
 * the onboarding mechanism until the admin UI exists (the JSON is the
 * migration source for these rows, not throwaway).
 *
 * Fields mirror the JSON schema one-to-one (see
 * `src/services/builder-config/builder-config.schema.ts`):
 * - `plan` is inert until billing lands (embed/04); null = undecided.
 * - Only business contact info lives here — no builder PII beyond that.
 */
export const tenants = pgTable('tenants', {
  /** Matches the repo JSON file name: `config/builders/{tenantKey}.json`. */
  tenantKey: text('tenant_key').primaryKey(),
  businessName: text('business_name').notNull(),
  displayName: text('display_name').notNull(),
  /** May be '' — the embed shell falls back to the Feasly wordmark. */
  logoUrl: text('logo_url').notNull().default(''),
  /** #rrggbb hex accent color. */
  accentColor: text('accent_color').notNull(),
  /** PostMessage origin allowlist — https origins (http localhost dev only). */
  allowedOrigins: text('allowed_origins').array().notNull(),
  fallbackPhone: text('fallback_phone').notNull().default(''),
  fallbackEmail: text('fallback_email').notNull().default(''),
  /** 'flat' | 'commission' | null (undecided). Inert until billing. */
  plan: text('plan'),
});

/**
 * API keys (api-mcp/01).
 *
 * Only the SHA-256 `key_hash` is stored — the plaintext is shown exactly
 * once at issuance/rotation and never persisted. `key_prefix` holds the
 * masked display form (`feasly_live_…abcd`) for the admin list.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    /** Human-readable label, e.g. "Elite Craft production". */
    name: text('name').notNull(),
    /** Optional tenant binding (embed track). Null = no tenant. */
    tenantId: text('tenant_id'),
    /** SHA-256 hex of the plaintext key — the ONLY stored credential form. */
    keyHash: text('key_hash').notNull().unique(),
    /** Masked display: `feasly_live_…abcd`. Never the full key. */
    keyPrefix: text('key_prefix').notNull(),
    /** Scope allowlist, e.g. ['property:read', 'estimate', 'lead']. */
    scopes: text('scopes').array().notNull(),
    /** Per-key rate limit (requests/minute). Default 100. */
    rateLimitPerMin: integer('rate_limit_per_min').notNull().default(100),
    /** True for `feasly_test_` keys: writes set sandbox=true (no emails). */
    sandbox: boolean('sandbox').notNull().default(false),
    /** Null = active. Set on revoke/rotate. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('api_keys_key_hash_idx').on(t.keyHash)],
);

/**
 * API key audit log (api-mcp/01).
 *
 * Every key lifecycle event: created, rotated, revoked, scope_changed,
 * auth_failed. `detail` is machine-readable and never contains key
 * material or PII.
 */
export const apiKeyAuditLog = pgTable(
  'api_key_audit_log',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    /** The key row; null when authentication failed (no identity). */
    apiKeyId: uuid('api_key_id'),
    /** 'created' | 'rotated' | 'revoked' | 'scope_changed' | 'auth_failed' */
    action: text('action').notNull(),
    /** Short machine-readable detail — never key material, never PII. */
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('api_key_audit_log_key_id_idx').on(t.apiKeyId)],
);

/**
 * Analytics events (story consumer/01). Append-only by design: no update or
 * delete path exists in the data layer. The payload shape is closed —
 * `event`, `route`, `ts`, `consent_ts` — so email, address, and figures
 * cannot be stored without a schema + contract change, which is the point.
 * First-party only: no cookies, no fingerprinting, no third-party trackers.
 */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    /** One of the allowlisted AnalyticsEventName contract values. */
    event: text('event').notNull(),
    /** Client route where the event occurred (e.g. '/estimate/gate'). */
    route: text('route').notNull(),
    /** Client-side occurrence timestamp. */
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    /** Consent-banner acknowledgement timestamp authorizing this event. */
    consentTs: timestamp('consent_ts', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('analytics_events_event_created_idx').on(t.event, t.createdAt)],
);
