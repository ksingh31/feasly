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
  unique,
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
    /**
     * api-mcp/09: true when created via a `feasly_test_` API key.
     * Sandbox rows auto-purge after 30 days (sandbox-purge timer).
     */
    sandbox: boolean('sandbox').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * consumer/06: AI-generated narrative (validated by
     * `validateNarrative()` before persistence). Nullable — absent until
     * the narrative worker runs. Immutable once set (re-generation is a
     * deliberate product decision, not an update path).
     */
    narrative: text('narrative'),
    narrativeGeneratedAt: timestamp('narrative_generated_at', {
      withTimezone: true,
    }),
    /**
     * consumer/06: engine-authored assumptions (the qualitative
     * engine→narrative channel). Only renovation estimates have them.
     */
    assumptions: jsonb('assumptions').$type<readonly string[] | null>(),
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
     * Quarantine review outcome (admin/02 follow-up). Set when an admin
     * discards a honeypot-flagged lead via
     * `POST /api/v1/admin/leads/{id}/quarantine/discard`. Discarded rows are
     * kept for audit but excluded from every listing and count (admin list,
     * quarantine tab, consumer lists, Sheets sync). `quarantined` stays true
     * so all existing quarantine exclusions keep working; `discarded`
     * distinguishes "reviewed and thrown away" from "pending review".
     */
    discarded: boolean('discarded').notNull().default(false),
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
    /**
     * api-mcp/09: true when created via a `feasly_test_` API key.
     * Sandbox rows auto-purge after 30 days (sandbox-purge timer).
     */
    sandbox: boolean('sandbox').notNull().default(false),
    /**
     * admin/04: Sheets sync watermark. NULL = never synced; otherwise the
     * timestamp of the last successful upsert to the Google Sheet.
     * The sync worker is the ONLY writer of this column (test asserts via DB diff).
     */
    sheetsSyncedAt: timestamp('sheets_synced_at', { withTimezone: true }),
    /**
     * admin/04: Last modification timestamp. Maintained by a DB trigger
     * (see migration 0013) — the sync worker uses it to detect leads
     * modified since their last sync (`updated_at > sheets_synced_at`).
     */
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
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
    /** 'lead' | 'partner-share' | 'admin' — extend as new issuance flows land. */
    purpose: text('purpose').notNull().default('lead'),
    /**
     * Admin auth (admin/01): the allowlisted email this link was issued for.
     * Null for lead flows (the email lives on the lead row).
     */
    email: text('email'),
    /** SHA-256 hex of the opaque bearer token. Never the raw token. */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set by the future verify flow when the link is redeemed. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** Set on erasure (links stop working) — kept as anonymized audit. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * api-mcp/09: true when created via a `feasly_test_` API key.
     * Sandbox rows auto-purge after 30 days (sandbox-purge timer).
     */
    sandbox: boolean('sandbox').notNull().default(false),
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
  /** Stripe customer id (`cus_…`) — set when card-on-file is captured. */
  stripeCustomerId: text('stripe_customer_id'),
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
    /**
     * api-mcp/09: true when created via a `feasly_test_` API key.
     * Sandbox rows auto-purge after 30 days (sandbox-purge timer).
     */
    sandbox: boolean('sandbox').notNull().default(false),
    /**
     * admin/07: tenant key for embed-attributed events. NULL = Feasly-direct
     * traffic. Set by embed clients; the funnel dashboard filters on it.
     */
    tenantKey: text('tenant_key'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('analytics_events_event_created_idx').on(t.event, t.createdAt),
    index('analytics_events_tenant_created_idx').on(t.tenantKey, t.createdAt),
  ],
);

/**
 * Attribution events (billing/01 foundation).
 *
 * Tracks the lead→builder introduction lifecycle that the 1% commission
 * model bills against — NOT the charge itself (charging, payouts, and the
 * pipeline dashboard wait on api-mcp/08 + embed/09).
 *
 * - `introducedAt` starts the 12-month attribution window
 *   (`BILLING_ATTRIBUTION_WINDOW_DAYS`).
 * - `contractSignedAt` starts the 14-day reporting SLA
 *   (`BILLING_REPORTING_SLA_DAYS`).
 * - `contractValueCents` is the signed construction contract value in
 *   integer cents, EXCLUDING land — set only when the builder reports.
 *
 * Status lifecycle: introduced → attributed | expired |
 * excluded_prior_relationship. Transitions are enforced in the service;
 * the DB stores the current state. Money is never float — integer cents.
 */
export const attributionEvents = pgTable(
  'attribution_events',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    /** Which builder tenant was introduced to the homeowner. */
    tenantKey: text('tenant_key').notNull(),
    /** When the introduction happened — the attribution window starts here. */
    introducedAt: timestamp('introduced_at', { withTimezone: true }).notNull(),
    /**
     * Signed construction contract value in integer cents, EXCLUDING land.
     * Null until the builder reports a signed contract.
     */
    contractValueCents: integer('contract_value_cents'),
    /**
     * When the contract was signed — the 14-day reporting SLA starts here.
     * Null until reported.
     */
    contractSignedAt: timestamp('contract_signed_at', { withTimezone: true }),
    /**
     * introduced: awaiting outcome.
     * attributed: contract reported inside the attribution window.
     * expired: window lapsed with no reported contract.
     * excluded_prior_relationship: builder proved a pre-existing
     *   relationship (proof burden on the builder — Karan 2026-09-24).
     */
    status: text('status').notNull().default('introduced'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('attribution_events_lead_tenant_idx').on(t.leadId, t.tenantKey),
    index('attribution_events_status_idx').on(t.status),
  ],
);

/**
 * API usage log (api-mcp/07).
 *
 * One row per ACCEPTED public API call, keyed by API key. This table is the
 * rate-limiting backend (sliding window: count rows for the key in the last
 * 60s) and the billing metering source. Rejected 429s write nothing here.
 *
 * Append-only by design: no update or delete path exists in the data layer.
 * `endpoint` is the route path (e.g. '/api/v1/estimate'); `estimate_id` is
 * set when the call created an estimate (feeds estimates_created aggregates).
 */
export const apiUsage = pgTable(
  'api_usage',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    /** The API key that made the call. */
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id),
    /** Route path, e.g. '/api/v1/estimate'. Never PII. */
    endpoint: text('endpoint').notNull(),
    /** Set when the call created an estimate; null otherwise. */
    estimateId: uuid('estimate_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('api_usage_key_id_idx').on(t.apiKeyId),
    index('api_usage_key_created_idx').on(t.apiKeyId, t.createdAt),
  ],
);

/**
 * Commission invoices (billing/02 commission engine).
 *
 * Internal billing records for the 1% commission model (Karan 2026-09-24):
 * each won deal (builder-reported signed contract) creates exactly one row.
 * Charges run through Stripe OFF-SESSION PaymentIntents — never Stripe
 * Invoices, so the 7-day review/dispute window and dispute-pause semantics
 * stay under Feasly's control (TECH_PLAN §2.4).
 *
 * Status lifecycle:
 *   draft → in_review (7-day review window; reviewDueAt = created + 7d)
 *   in_review → finalized (review passed, PaymentIntent created off-session)
 *   finalized → paid (payment_intent.succeeded webhook)
 *   finalized → failed (payment_intent.payment_failed webhook → dunning)
 *   in_review → disputed (builder disputes — charge clock FROZEN)
 *   disputed → in_review (human accepts resolution) | void (human voids)
 * Terminal: paid, failed, void. Disputed rows are skipped by the
 * invoice-reviewer timer until a human resolves them.
 *
 * Money is integer cents — never float.
 */
export const commissionInvoices = pgTable(
  'commission_invoices',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    /** Which builder tenant owes the commission. */
    tenantKey: text('tenant_key')
      .notNull()
      .references(() => tenants.tenantKey),
    /** The attribution whose reported contract this invoice bills. */
    attributionId: uuid('attribution_id')
      .notNull()
      .references(() => attributionEvents.id),
    /** Denormalized from the attribution for invoice queries. */
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    /** Signed construction contract value in integer cents, EXCL. land. */
    contractValueCents: integer('contract_value_cents').notNull(),
    /** round(contractValueCents * BILLING_COMMISSION_RATE), integer cents. */
    commissionCents: integer('commission_cents').notNull(),
    currency: text('currency').notNull().default('CAD'),
    /** Off-session PaymentIntent created at finalize. UNIQUE — one PI max. */
    stripePaymentIntentId: text('stripe_payment_intent_id').unique(),
    status: text('status').notNull().default('draft'),
    /** draft created + 7 days — the builder's review/dispute window. */
    reviewDueAt: timestamp('review_due_at', { withTimezone: true }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** True when the contract was reported after the 14-day reporting SLA. */
    slaBreached: boolean('sla_breached').notNull().default(false),
    /** Builder-supplied reason while status='disputed'. */
    disputeReason: text('dispute_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('commission_invoices_tenant_status_idx').on(t.tenantKey, t.status),
    index('commission_invoices_review_due_idx').on(t.reviewDueAt),
  ],
);

/**
 * Stripe webhook idempotency (billing/02).
 *
 * Every received Stripe event id is inserted BEFORE dispatch. A unique
 * violation means the event was already handled → the route returns 200
 * without re-dispatching, so Stripe retries never double-apply.
 */
export const stripeEvents = pgTable('stripe_events', {
  /** Stripe event id (`evt_…`) — the idempotency key. */
  eventId: text('event_id').primaryKey(),
  /** Stripe event type, e.g. `payment_intent.succeeded`. */
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Billing audit log (billing/02).
 *
 * APPEND-ONLY: every billing state change writes exactly one row
 * (invoice created / status transition / dispute / charge attempt /
 * subscription change / SLA breach / webhook dispatch). Rows are never
 * updated or deleted — reconciliation reads this table.
 */
export const billingEvents = pgTable(
  'billing_events',
  {
    /** App-generated UUID (node:crypto). */
    id: uuid('id').primaryKey(),
    /** Builder tenant the event belongs to. Null for platform-level events. */
    tenantKey: text('tenant_key'),
    /** e.g. `invoice.created`, `invoice.disputed`, `subscription.created`. */
    eventType: text('event_type').notNull(),
    /** e.g. `commission_invoice`, `stripe_subscription`, `attribution`. */
    entityType: text('entity_type').notNull(),
    /** The entity's id (invoice id, subscription id, …). */
    entityId: text('entity_id').notNull(),
    /** Event-specific payload (amounts, reasons, Stripe ids). */
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('billing_events_tenant_created_idx').on(t.tenantKey, t.createdAt),
    index('billing_events_entity_idx').on(t.entityType, t.entityId),
  ],
);

/**
 * Ops alert dedupe state (admin/06).
 *
 * One row per alert class (e.g. 'sheets_sync_failed'). The alert service
 * sends at most one failure email per class per 24h (dedupe anchor =
 * last_fired_at) and one all-clear on recovery (last_recovered_at).
 * Persisted so a cold start doesn't reset the dedupe window and re-spam
 * Karan. Only the alert service writes here.
 */
export const opsAlertState = pgTable('ops_alert_state', {
  /** Alert class, e.g. 'sheets_sync_failed'. */
  type: text('type').primaryKey(),
  /** When the last failure email for this class was sent (dedupe anchor). */
  lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
  /** When the last all-clear email for this class was sent. */
  lastRecoveredAt: timestamp('last_recovered_at', { withTimezone: true }),
});

/**
 * Sheets sync worker health (admin/04).
 *
 * Single-row table (id = 'singleton') tracking the hourly sync worker.
 * The `lagging` flag IS the `sheets_sync.lagging` metric from AC4: set
 * true on the 3rd consecutive cycle failure, cleared on recovery.
 * Persisted (not in-memory) so a Function App restart or scale-out doesn't
 * reset the failure counter or hide a lagging sync. Read by admin/05's
 * status view (`lagging`, `consecutiveFailures`, `lastRunAt`,
 * `lastSuccessAt`, `rowsSyncedTotal`). Only the sync worker writes here.
 */
export const sheetsSyncState = pgTable('sheets_sync_state', {
  /** Always 'singleton' — one row for the whole worker. */
  id: text('id').primaryKey(),
  /** When the last sync cycle ran (success or failure). */
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  /** When the last sync cycle succeeded. */
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  /** Consecutive cycle failures (resets to 0 on success). */
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  /** When the current failure streak started (null when healthy). */
  firstFailureAt: timestamp('first_failure_at', { withTimezone: true }),
  /** Lifetime rows synced (for the admin/05 status view). */
  rowsSyncedTotal: integer('rows_synced_total').notNull().default(0),
  /** The `sheets_sync.lagging` metric: true from the 3rd consecutive failure until recovery. */
  lagging: boolean('lagging').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Admin allowlist (admin/01).
 *
 * Email is the PK, stored lowercased + trimmed (same discipline as leads).
 * Only allowlisted emails can request an admin magic link. Seeded with
 * Karan's email; changes are audit-logged in `admin_audit_log`.
 */
export const adminAllowlist = pgTable('admin_allowlist', {
  /** Lowercased, trimmed email — the PK. */
  email: text('email').primaryKey(),
  /** Email of the admin who added this entry (or 'seed' for the initial row). */
  addedBy: text('added_by').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Admin sessions (admin/01).
 *
 * One row per active admin session. Only the SHA-256 hash of the opaque
 * session token is stored — the plaintext lives only in the httpOnly
 * session cookie. 7-day expiry (D-02, same as consumer magic links).
 */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    /** Lowercased, trimmed admin email (from the allowlist). */
    email: text('email').notNull(),
    /** SHA-256 hex of the opaque session token — the ONLY stored form. */
    sessionTokenHash: text('session_token_hash').notNull().unique(),
    /** Null = active. Set on logout/expiry. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('admin_sessions_token_hash_idx').on(t.sessionTokenHash),
    index('admin_sessions_email_idx').on(t.email),
  ],
);

/**
 * Admin audit log (admin/01).
 *
 * Allowlist changes (add/remove) and auth events. `detail` is
 * machine-readable and never contains tokens or credentials.
 */
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    /** Actor email (the admin performing the action), null for system. */
    actorEmail: text('actor_email'),
    /** 'allowlist_added' | 'allowlist_removed' | 'magic_link_requested' | 'session_created' | 'session_revoked' | 'auth_failed' */
    action: text('action').notNull(),
    /** Short machine-readable detail — never tokens, never credentials. */
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('admin_audit_log_action_idx').on(t.action)],
);

/**
/**
 * Callback requests (phase-2 wiring).
 *
 * A "call me back" ask attached to a report. The reportToken resolves to
 * the lead at request time — only the leadId is persisted (the token itself
 * is a bearer credential and is never stored).
 */
export const callbackRequests = pgTable(
  'callback_requests',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    name: text('name').notNull(),
    /** Required at the callback step (optional at the lead gate). */
    phone: text('phone').notNull(),
    /** 'morning' | 'afternoon' | 'evening' (contracts CallbackWindow). */
    window: text('window').notNull(),
    /** 'pending' → 'done' — worked by the team inbox flow (future). */
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('callback_requests_lead_id_idx').on(t.leadId)],
);

/**
 * Partner shares (phase-2 wiring).
 *
 * Audit record for each email-to-partner share. The partner's credential is
 * a fresh magic-link row (purpose 'partner-share', lead_id → the owner's
 * lead — never the owner's token); this table records who it went to and
 * whether the email provider accepted the message. The partner email is PII
 * and gets the same handling as lead emails.
 */
export const partnerShares = pgTable(
  'partner_shares',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    magicLinkId: uuid('magic_link_id').references(() => magicLinks.id, {
      onDelete: 'set null',
    }),
    partnerEmail: text('partner_email').notNull(),
    /** True when the email provider accepted the message. */
    sent: boolean('sent').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('partner_shares_lead_id_idx').on(t.leadId)],
);

/**
 * Report snapshots (phase-2 wiring).
 *
 * Immutable per-version copies of an estimate's report figures. Snapshots
 * exist only post-gate: v1 is created lazily on the first
 * GET /v1/reports/{reportToken}; tier/sqft revisions append v+1. The report
 * page renders the LATEST snapshot for the estimate — a shared link
 * re-renders exactly the same numbers.
 *
 * Money is integer dollars inside the JSONB payloads (never float), matching
 * the estimates table convention.
 */
export const reportSnapshots = pgTable(
  'report_snapshots',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    estimateId: uuid('estimate_id')
      .notNull()
      .references(() => estimates.id),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    /** Contract `EstimateInputs` (renovation inputs merged under `renoInputs`). */
    inputs: jsonb('inputs').notNull(),
    /** Contract `CostRange` { low, base, high }. */
    buildRange: jsonb('build_range').notNull(),
    totalRange: jsonb('total_range').notNull(),
    /** Contract `FixedFigure` { value } — the City assessed value. */
    landValue: jsonb('land_value').notNull(),
    /** Contract `CostRow[]`. */
    rows: jsonb('rows').notNull(),
    /** AI narrative — '' until the narrative worker fills it in. */
    narrative: text('narrative').notNull().default(''),
    /** Engine-authored assumptions (renovation snapshots only). */
    assumptions: jsonb('assumptions').$type<readonly string[] | null>(),
    /** 'new_build' | 'renovation' — comparison estimates have no snapshots. */
    projectType: text('project_type').notNull().default('new_build'),
    /** Contract `RenoEstimateInputs`, present only for renovations. */
    renoInputs: jsonb('reno_inputs'),
    /** Monotonic per estimateId, starting at 1. */
    version: integer('version').notNull(),
    preparedAt: timestamp('prepared_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Set when an old magic link resolved to a newer snapshot
     * (consumer/02). The report header shows "Updated {date}" from it.
     * Absent for first-view reports.
     */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('report_snapshots_estimate_id_idx').on(t.estimateId),
    unique('report_snapshots_estimate_version_uq').on(t.estimateId, t.version),
  ],
);


/**
 * Sheets sync run history (admin/05).
 *
 * Every sync cycle (hourly timer from admin/04 + admin manual trigger from
 * admin/05) records one row: the worker's run state is durable and
 * restart-safe here instead of process memory. `status` is
 * 'running' | 'success' | 'failed' | 'disabled'. `error_message` is the
 * SANITIZED worker error text (no credentials, no PII).
 */
export const sheetsSyncRuns = pgTable(
  'sheets_sync_runs',
  {
    /** App-generated UUID (node:crypto) — no pgcrypto dependency. */
    id: uuid('id').primaryKey(),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** 'timer' (hourly admin/04 run) or 'manual' (admin/05 "Sync now"). */
    trigger: text('trigger').notNull(),
    /** Admin email for manual runs; null for timer runs. */
    actorEmail: text('actor_email'),
    /** 'running' | 'success' | 'failed' | 'disabled'. */
    status: text('status').notNull(),
    syncedCount: integer('synced_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    /** Sanitized error text — never credentials, never PII. */
    errorMessage: text('error_message'),
  },
  (t) => [index('sheets_sync_runs_started_at_idx').on(t.startedAt)],
);
