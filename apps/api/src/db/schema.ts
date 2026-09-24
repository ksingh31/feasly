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
