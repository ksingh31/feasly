/**
 * Idempotent schema-repair SQL.
 *
 * Safety net for drizzle-kit's silent migration skips (observed on dev:
 * 0025, 0028 marked applied but columns missing; 0030 silently skipped).
 * After `drizzle-kit migrate`, every table/column the Drizzle schema
 * declares is ensured with IF NOT EXISTS — a no-op on a healthy database.
 *
 * REGRESSION GUARD (2026-09-27 P0): the consumer report endpoint
 * (GET /api/v1/reports/{token}) 500'd for every property because the
 * `report_snapshots` table (migration 0024) never materialized on dev and
 * this repair script didn't cover it. `test/schema-repair-coverage.test.ts`
 * asserts EVERY pgTable in the Drizzle schema appears here — add new tables
 * to this file when you add them to the schema.
 */
export const REPAIR_SQL = `
CREATE TABLE IF NOT EXISTS "leads" (

	"id" uuid PRIMARY KEY NOT NULL,
	"estimate_id" uuid NOT NULL,
	"address_key" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"timeline" text NOT NULL,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"consent_ts" timestamp with time zone NOT NULL,
	"tenant_key" text,
	"source" text DEFAULT 'api' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "discarded" boolean DEFAULT false NOT NULL;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "tenant_key" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "quarantined" boolean DEFAULT false NOT NULL;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lead_score" integer DEFAULT 0 NOT NULL;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'new' NOT NULL;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "unsubscribed_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "contact_opt_out_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "consent_updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "nudge_sent_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sheets_synced_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "builder_id" uuid;
CREATE TABLE IF NOT EXISTS "builders" (

	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_key" text NOT NULL,
	"business_name" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"phone" text,
	"logo_url" text,
	"accent_color" text,
	"allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan" text,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builders_tenant_key_unique" UNIQUE("tenant_key")
);
CREATE TABLE IF NOT EXISTS "magic_links" (

	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid,
	"purpose" text DEFAULT 'lead' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_links_token_hash_unique" UNIQUE("token_hash")
);
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;
CREATE TABLE IF NOT EXISTS "estimates" (

	"id" uuid PRIMARY KEY NOT NULL,
	"address_key" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"figures" jsonb NOT NULL,
	"rows" jsonb NOT NULL,
	"cost_data_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "project_type" text DEFAULT 'new_build' NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "address_key" text NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "tenant_key" text;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "inputs" jsonb NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "figures" jsonb NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "rows" jsonb NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "cost_data_version" text NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "narrative" text;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "narrative_generated_at" timestamp with time zone;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "assumptions" jsonb;
-- sheets-sync-timer 500s on live dev (2026-09-27 00:00 UTC): insert into
-- sheets_sync_runs failed with the same drift signature (missing column,
-- exact name truncated in telemetry). Idempotent repair for every column
-- the sheets sync worker writes. CREATE TABLE IF NOT EXISTS first covers
-- the case where drizzle-kit skipped the table-creation migration entirely.
CREATE TABLE IF NOT EXISTS "sheets_sync_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "trigger" text NOT NULL,
  "actor_email" text,
  "status" text NOT NULL,
  "synced_count" integer DEFAULT 0 NOT NULL,
  "skipped_count" integer DEFAULT 0 NOT NULL,
  "error_message" text
);
CREATE TABLE IF NOT EXISTS "sheets_sync_state" (
  "id" text PRIMARY KEY NOT NULL,
  "last_run_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "first_failure_at" timestamp with time zone,
  "rows_synced_total" integer DEFAULT 0 NOT NULL,
  "lagging" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "finished_at" timestamp with time zone;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "trigger" text NOT NULL;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "actor_email" text;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "status" text NOT NULL;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "synced_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "skipped_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "error_message" text;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "id" text;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "last_run_at" timestamp with time zone;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "last_success_at" timestamp with time zone;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "consecutive_failures" integer DEFAULT 0 NOT NULL;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "first_failure_at" timestamp with time zone;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "rows_synced_total" integer DEFAULT 0 NOT NULL;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "lagging" boolean DEFAULT false NOT NULL;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
-- P0 2026-09-27: GET /api/v1/reports/{token} 500'd for every property —
-- the report_snapshots table (migration 0024) never materialized on dev
-- (drizzle-kit silent skip) and the repair script didn't cover it.
-- CREATE TABLE IF NOT EXISTS covers the skipped-migration case; the
-- per-column ALTERs cover the partially-applied case.
CREATE TABLE IF NOT EXISTS "report_snapshots" (
  "id" uuid PRIMARY KEY NOT NULL,
  "estimate_id" uuid NOT NULL,
  "lead_id" uuid NOT NULL,
  "inputs" jsonb NOT NULL,
  "build_range" jsonb NOT NULL,
  "total_range" jsonb NOT NULL,
  "land_value" jsonb NOT NULL,
  "rows" jsonb NOT NULL,
  "narrative" text DEFAULT '' NOT NULL,
  "assumptions" jsonb,
  "project_type" text DEFAULT 'new_build' NOT NULL,
  "reno_inputs" jsonb,
  "version" integer NOT NULL,
  "prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "report_snapshots_estimate_version_uq" UNIQUE("estimate_id","version")
);
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "estimate_id" uuid;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "lead_id" uuid;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "inputs" jsonb;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "build_range" jsonb;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "total_range" jsonb;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "land_value" jsonb;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "rows" jsonb;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "narrative" text DEFAULT '' NOT NULL;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "assumptions" jsonb;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "project_type" text DEFAULT 'new_build' NOT NULL;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "reno_inputs" jsonb;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "version" integer;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "prepared_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "report_snapshots" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
-- P0 2026-09-27: full schema coverage. Every table below was missing
-- from the repair script — a silently-skipped migration for ANY of them
-- would break its endpoint on dev with no safety net. Generated from the
-- CREATE TABLE statements in src/db/migrations/*.sql.
CREATE TABLE IF NOT EXISTS "erasure_requests" (

	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid,
	"email_hash" text NOT NULL,
	"status" text NOT NULL,
	"blockers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
ALTER TABLE "erasure_requests" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "erasure_requests" ADD COLUMN IF NOT EXISTS "lead_id" uuid;
ALTER TABLE "erasure_requests" ADD COLUMN IF NOT EXISTS "email_hash" text NOT NULL;
ALTER TABLE "erasure_requests" ADD COLUMN IF NOT EXISTS "status" text NOT NULL;
ALTER TABLE "erasure_requests" ADD COLUMN IF NOT EXISTS "blockers" jsonb;
ALTER TABLE "erasure_requests" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "erasure_requests" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS "privacy_audit_log" (

	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "privacy_audit_log" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "privacy_audit_log" ADD COLUMN IF NOT EXISTS "lead_id" uuid;
ALTER TABLE "privacy_audit_log" ADD COLUMN IF NOT EXISTS "action" text NOT NULL;
ALTER TABLE "privacy_audit_log" ADD COLUMN IF NOT EXISTS "detail" text;
ALTER TABLE "privacy_audit_log" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "lead_notes" (

	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "lead_notes" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "lead_notes" ADD COLUMN IF NOT EXISTS "lead_id" uuid NOT NULL;
ALTER TABLE "lead_notes" ADD COLUMN IF NOT EXISTS "note" text NOT NULL;
ALTER TABLE "lead_notes" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "lead_status_history" (

	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"old_status" text,
	"new_status" text NOT NULL,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "lead_status_history" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "lead_status_history" ADD COLUMN IF NOT EXISTS "lead_id" uuid NOT NULL;
ALTER TABLE "lead_status_history" ADD COLUMN IF NOT EXISTS "old_status" text;
ALTER TABLE "lead_status_history" ADD COLUMN IF NOT EXISTS "new_status" text NOT NULL;
ALTER TABLE "lead_status_history" ADD COLUMN IF NOT EXISTS "changed_by" text;
ALTER TABLE "lead_status_history" ADD COLUMN IF NOT EXISTS "changed_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "community_stats" (

	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"avg_assessed_value" integer NOT NULL,
	"assessment_count" integer NOT NULL,
	"avg_lot_sqft" integer,
	"refreshed_at" timestamp with time zone NOT NULL
);
ALTER TABLE "community_stats" ADD COLUMN IF NOT EXISTS "slug" text PRIMARY KEY NOT NULL;
ALTER TABLE "community_stats" ADD COLUMN IF NOT EXISTS "name" text NOT NULL;
ALTER TABLE "community_stats" ADD COLUMN IF NOT EXISTS "avg_assessed_value" integer NOT NULL;
ALTER TABLE "community_stats" ADD COLUMN IF NOT EXISTS "assessment_count" integer NOT NULL;
ALTER TABLE "community_stats" ADD COLUMN IF NOT EXISTS "avg_lot_sqft" integer;
ALTER TABLE "community_stats" ADD COLUMN IF NOT EXISTS "refreshed_at" timestamp with time zone NOT NULL;
CREATE TABLE IF NOT EXISTS "tenants" (

	"tenant_key" text PRIMARY KEY NOT NULL,
	"business_name" text NOT NULL,
	"display_name" text NOT NULL,
	"logo_url" text DEFAULT '' NOT NULL,
	"accent_color" text NOT NULL,
	"allowed_origins" text[] NOT NULL,
	"fallback_phone" text DEFAULT '' NOT NULL,
	"fallback_email" text DEFAULT '' NOT NULL,
	"plan" text
);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "tenant_key" text PRIMARY KEY NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "business_name" text NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "display_name" text NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "logo_url" text DEFAULT '' NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "accent_color" text NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "allowed_origins" text[] NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "fallback_phone" text DEFAULT '' NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "fallback_email" text DEFAULT '' NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "plan" text;
CREATE TABLE IF NOT EXISTS "api_key_audit_log" (

	"id" uuid PRIMARY KEY NOT NULL,
	"api_key_id" uuid,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "api_key_audit_log" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "api_key_audit_log" ADD COLUMN IF NOT EXISTS "api_key_id" uuid;
ALTER TABLE "api_key_audit_log" ADD COLUMN IF NOT EXISTS "action" text NOT NULL;
ALTER TABLE "api_key_audit_log" ADD COLUMN IF NOT EXISTS "detail" text;
ALTER TABLE "api_key_audit_log" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "api_keys" (

	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tenant_id" text,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text[] NOT NULL,
	"rate_limit_per_min" integer DEFAULT 100 NOT NULL,
	"sandbox" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "name" text NOT NULL;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "tenant_id" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "key_hash" text NOT NULL;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "key_prefix" text NOT NULL;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "scopes" text[] NOT NULL;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rate_limit_per_min" integer DEFAULT 100 NOT NULL;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "analytics_events" (

	"id" uuid PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"route" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"consent_ts" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "event" text NOT NULL;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "route" text NOT NULL;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "ts" timestamp with time zone NOT NULL;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "consent_ts" timestamp with time zone NOT NULL;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "attribution_events" (

	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"tenant_key" text NOT NULL,
	"introduced_at" timestamp with time zone NOT NULL,
	"contract_value_cents" integer,
	"contract_signed_at" timestamp with time zone,
	"status" text DEFAULT 'introduced' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "lead_id" uuid NOT NULL;
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "tenant_key" text NOT NULL;
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "introduced_at" timestamp with time zone NOT NULL;
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "contract_value_cents" integer;
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "contract_signed_at" timestamp with time zone;
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'introduced' NOT NULL;
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "api_usage" (

	"id" uuid PRIMARY KEY NOT NULL,
	"api_key_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"estimate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "api_usage" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "api_usage" ADD COLUMN IF NOT EXISTS "api_key_id" uuid NOT NULL;
ALTER TABLE "api_usage" ADD COLUMN IF NOT EXISTS "endpoint" text NOT NULL;
ALTER TABLE "api_usage" ADD COLUMN IF NOT EXISTS "estimate_id" uuid;
ALTER TABLE "api_usage" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "billing_events" (

	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_key" text,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "billing_events" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "billing_events" ADD COLUMN IF NOT EXISTS "tenant_key" text;
ALTER TABLE "billing_events" ADD COLUMN IF NOT EXISTS "event_type" text NOT NULL;
ALTER TABLE "billing_events" ADD COLUMN IF NOT EXISTS "entity_type" text NOT NULL;
ALTER TABLE "billing_events" ADD COLUMN IF NOT EXISTS "entity_id" text NOT NULL;
ALTER TABLE "billing_events" ADD COLUMN IF NOT EXISTS "payload" jsonb;
ALTER TABLE "billing_events" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "commission_invoices" (

	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_key" text NOT NULL,
	"attribution_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"contract_value_cents" integer NOT NULL,
	"commission_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"stripe_payment_intent_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"review_due_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"sla_breached" boolean DEFAULT false NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"dispute_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_invoices_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "tenant_key" text NOT NULL;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "attribution_id" uuid NOT NULL;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "lead_id" uuid NOT NULL;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "contract_value_cents" integer NOT NULL;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "commission_cents" integer NOT NULL;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'CAD' NOT NULL;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" text;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'draft' NOT NULL;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "review_due_at" timestamp with time zone;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "finalized_at" timestamp with time zone;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "paid_at" timestamp with time zone;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "sla_breached" boolean DEFAULT false NOT NULL;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "retry_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "dispute_reason" text;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "stripe_events" (

	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "stripe_events" ADD COLUMN IF NOT EXISTS "event_id" text PRIMARY KEY NOT NULL;
ALTER TABLE "stripe_events" ADD COLUMN IF NOT EXISTS "type" text NOT NULL;
ALTER TABLE "stripe_events" ADD COLUMN IF NOT EXISTS "received_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "ops_alert_state" (

	"type" text PRIMARY KEY NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_recovered_at" timestamp with time zone
);
ALTER TABLE "ops_alert_state" ADD COLUMN IF NOT EXISTS "type" text PRIMARY KEY NOT NULL;
ALTER TABLE "ops_alert_state" ADD COLUMN IF NOT EXISTS "last_fired_at" timestamp with time zone;
ALTER TABLE "ops_alert_state" ADD COLUMN IF NOT EXISTS "last_recovered_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS "billing_disputes" (

	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"tenant_key" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sla_due_at" timestamp with time zone NOT NULL,
	"sla_breached_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "invoice_id" uuid NOT NULL;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "tenant_key" text NOT NULL;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "reason" text NOT NULL;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "evidence_snapshot" jsonb NOT NULL;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'open' NOT NULL;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "opened_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "sla_due_at" timestamp with time zone NOT NULL;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "sla_breached_at" timestamp with time zone;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "resolved_by" text;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "resolution_note" text;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "admin_allowlist" (

	"email" text PRIMARY KEY NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "admin_allowlist" ADD COLUMN IF NOT EXISTS "email" text PRIMARY KEY NOT NULL;
ALTER TABLE "admin_allowlist" ADD COLUMN IF NOT EXISTS "added_by" text NOT NULL;
ALTER TABLE "admin_allowlist" ADD COLUMN IF NOT EXISTS "added_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "admin_audit_log" (

	"id" uuid PRIMARY KEY NOT NULL,
	"actor_email" text,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "actor_email" text;
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "action" text NOT NULL;
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "detail" text;
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "admin_sessions" (

	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"session_token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_builder_id" uuid REFERENCES "builders"("id") ON DELETE SET NULL,
	"view_as" jsonb,
	CONSTRAINT "admin_sessions_session_token_hash_unique" UNIQUE("session_token_hash")
);
ALTER TABLE "admin_sessions" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "admin_sessions" ADD COLUMN IF NOT EXISTS "email" text NOT NULL;
ALTER TABLE "admin_sessions" ADD COLUMN IF NOT EXISTS "session_token_hash" text NOT NULL;
ALTER TABLE "admin_sessions" ADD COLUMN IF NOT EXISTS "id_token" text;
ALTER TABLE "admin_sessions" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
ALTER TABLE "admin_sessions" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone NOT NULL;
ALTER TABLE "admin_sessions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "users" (

	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"staff_role" text,
	"entra_object_id" text,
	"is_protected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_entra_object_id_unique" UNIQUE("entra_object_id")
);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "name" text NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'invited' NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "staff_role" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "entra_object_id" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_protected" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "admin_sessions" ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "admin_sessions" ADD COLUMN IF NOT EXISTS "active_builder_id" uuid REFERENCES "builders"("id") ON DELETE SET NULL;
ALTER TABLE "admin_sessions" ADD COLUMN IF NOT EXISTS "view_as" jsonb;
CREATE TABLE IF NOT EXISTS "builder_memberships" (

	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"builder_id" uuid NOT NULL REFERENCES "builders"("id") ON DELETE CASCADE,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "builder_memberships" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "builder_memberships" ADD COLUMN IF NOT EXISTS "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "builder_memberships" ADD COLUMN IF NOT EXISTS "builder_id" uuid NOT NULL REFERENCES "builders"("id") ON DELETE CASCADE;
ALTER TABLE "builder_memberships" ADD COLUMN IF NOT EXISTS "role" text NOT NULL;
ALTER TABLE "builder_memberships" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "invitations" (

	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"invited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"role" text NOT NULL,
	"builder_id" uuid REFERENCES "builders"("id") ON DELETE CASCADE,
	"entra_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "email" text NOT NULL;
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "invited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "role" text NOT NULL;
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "builder_id" uuid REFERENCES "builders"("id") ON DELETE CASCADE;
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "entra_user_id" text;
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending' NOT NULL;
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone NOT NULL;
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "callback_requests" (

	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"window" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "lead_id" uuid NOT NULL;
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "name" text NOT NULL;
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "phone" text NOT NULL;
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "window" text NOT NULL;
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending' NOT NULL;
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "partner_shares" (

	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"magic_link_id" uuid,
	"partner_email" text NOT NULL,
	"sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "partner_shares" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "partner_shares" ADD COLUMN IF NOT EXISTS "lead_id" uuid NOT NULL;
ALTER TABLE "partner_shares" ADD COLUMN IF NOT EXISTS "magic_link_id" uuid;
ALTER TABLE "partner_shares" ADD COLUMN IF NOT EXISTS "partner_email" text NOT NULL;
ALTER TABLE "partner_shares" ADD COLUMN IF NOT EXISTS "sent" boolean DEFAULT false NOT NULL;
ALTER TABLE "partner_shares" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "builder_allowlist" (

	"email" text PRIMARY KEY NOT NULL,
	"tenant_key" text NOT NULL REFERENCES "tenants"("tenant_key") ON DELETE CASCADE,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "builder_allowlist" ADD COLUMN IF NOT EXISTS "email" text PRIMARY KEY NOT NULL;
ALTER TABLE "builder_allowlist" ADD COLUMN IF NOT EXISTS "tenant_key" text NOT NULL REFERENCES "tenants"("tenant_key") ON DELETE CASCADE;
ALTER TABLE "builder_allowlist" ADD COLUMN IF NOT EXISTS "added_by" text NOT NULL;
ALTER TABLE "builder_allowlist" ADD COLUMN IF NOT EXISTS "added_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "builder_sessions" (

	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"tenant_key" text NOT NULL REFERENCES "tenants"("tenant_key") ON DELETE CASCADE,
	"session_token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_sessions_session_token_hash_unique" UNIQUE("session_token_hash")
);
ALTER TABLE "builder_sessions" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "builder_sessions" ADD COLUMN IF NOT EXISTS "email" text NOT NULL;
ALTER TABLE "builder_sessions" ADD COLUMN IF NOT EXISTS "tenant_key" text NOT NULL REFERENCES "tenants"("tenant_key") ON DELETE CASCADE;
ALTER TABLE "builder_sessions" ADD COLUMN IF NOT EXISTS "session_token_hash" text NOT NULL;
ALTER TABLE "builder_sessions" ADD COLUMN IF NOT EXISTS "id_token" text;
ALTER TABLE "builder_sessions" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
ALTER TABLE "builder_sessions" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone NOT NULL;
ALTER TABLE "builder_sessions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "builder_sessions" ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "builder_sessions" ADD COLUMN IF NOT EXISTS "builder_id" uuid REFERENCES "builders"("id") ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS "embed_relay_codes" (

	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"tenant_key" text NOT NULL,
	"user_id" uuid,
	"estimate_id" uuid,
	"lead_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embed_relay_codes_code_hash_unique" UNIQUE("code_hash")
);
ALTER TABLE "embed_relay_codes" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "embed_relay_codes" ADD COLUMN IF NOT EXISTS "code_hash" text NOT NULL;
ALTER TABLE "embed_relay_codes" ADD COLUMN IF NOT EXISTS "tenant_key" text NOT NULL;
ALTER TABLE "embed_relay_codes" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "embed_relay_codes" ADD COLUMN IF NOT EXISTS "estimate_id" uuid;
ALTER TABLE "embed_relay_codes" ADD COLUMN IF NOT EXISTS "lead_id" uuid;
ALTER TABLE "embed_relay_codes" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone NOT NULL;
ALTER TABLE "embed_relay_codes" ADD COLUMN IF NOT EXISTS "used_at" timestamp with time zone;
ALTER TABLE "embed_relay_codes" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE TABLE IF NOT EXISTS "embed_relay_audit_log" (

	"id" uuid PRIMARY KEY NOT NULL,
	"code_id" uuid,
	"tenant_key" text NOT NULL,
	"ip_hash" text NOT NULL,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "embed_relay_audit_log" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "embed_relay_audit_log" ADD COLUMN IF NOT EXISTS "code_id" uuid;
ALTER TABLE "embed_relay_audit_log" ADD COLUMN IF NOT EXISTS "tenant_key" text NOT NULL;
ALTER TABLE "embed_relay_audit_log" ADD COLUMN IF NOT EXISTS "ip_hash" text NOT NULL;
ALTER TABLE "embed_relay_audit_log" ADD COLUMN IF NOT EXISTS "action" text NOT NULL;
ALTER TABLE "embed_relay_audit_log" ADD COLUMN IF NOT EXISTS "detail" text;
ALTER TABLE "embed_relay_audit_log" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;

-- P0 2026-09-27: columns added via ALTER TABLE in migrations (not in the
-- original CREATE TABLE), plus two NOT NULL columns the hand-written repair
-- list omitted (leads.timeline, magic_links.purpose).
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "tenant_key" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "timeline" text;
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'lead';

-- P0 2026-09-27: base columns for the hand-repaired tables. The original
-- repair list only covered newly-added columns; if drizzle-kit skipped the
-- table-creation migration entirely, the base columns would still be missing.
-- NOT NULL is dropped here (existing rows must not fail the repair).
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "estimate_id" uuid;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "address_key" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "phone" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "marketing_consent" boolean DEFAULT false;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "consent_ts" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'api';
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY;
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "lead_id" uuid;
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "token_hash" text;
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "used_at" timestamp with time zone;
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

-- P0 2026-09-28: bootstrap-data guard. drizzle-kit silently skipped
-- migration 0036 on dev (users table never materialized), so the protected
-- super_admin seed row may also be missing even after the schema repair
-- above creates the tables. This idempotent INSERT mirrors 0036's seed
-- exactly (same fixed UUID) and is a no-op when the row already exists.
-- Without it, the Entra callback has no protected row to link and Karan
-- cannot sign in.
INSERT INTO "users"
  ("id", "email", "name", "status", "staff_role", "entra_object_id", "is_protected")
SELECT
  '805793cc-5aca-46f4-9498-996c784aee5a',
  'karanbirsingh667@gmail.com',
  'Karan',
  'invited',
  'super_admin',
  NULL,
  true
WHERE EXISTS (
  SELECT 1 FROM "admin_allowlist" WHERE "email" = 'karanbirsingh667@gmail.com'
)
ON CONFLICT ("email") DO NOTHING;
`;
