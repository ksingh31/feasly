-- repair-missing-tables.sql
-- Idempotent repair: recreates any tables that are missing from the dev database.
-- Generated from apps/api/src/db/migrations/*.sql (origin/main).
-- Safe to run multiple times: all statements use IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "estimates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"address_key" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"figures" jsonb NOT NULL,
	"rows" jsonb NOT NULL,
	"cost_data_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
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
CREATE INDEX IF NOT EXISTS "estimates_address_key_idx" ON "estimates" USING btree ("address_key");
CREATE INDEX IF NOT EXISTS "leads_address_email_created_idx" ON "leads" USING btree ("address_key","email","created_at");

CREATE TABLE IF NOT EXISTS "erasure_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid,
	"email_hash" text NOT NULL,
	"status" text NOT NULL,
	"blockers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
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
CREATE TABLE IF NOT EXISTS "privacy_audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "erasure_requests_email_hash_idx" ON "erasure_requests" USING btree ("email_hash");
CREATE INDEX IF NOT EXISTS "magic_links_lead_id_idx" ON "magic_links" USING btree ("lead_id");
CREATE INDEX IF NOT EXISTS "privacy_audit_log_lead_id_idx" ON "privacy_audit_log" USING btree ("lead_id");

CREATE TABLE IF NOT EXISTS "lead_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "lead_status_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"old_status" text,
	"new_status" text NOT NULL,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "lead_notes_lead_id_idx" ON "lead_notes" USING btree ("lead_id");
CREATE INDEX IF NOT EXISTS "lead_status_history_lead_id_idx" ON "lead_status_history" USING btree ("lead_id");

CREATE TABLE IF NOT EXISTS "community_stats" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"avg_assessed_value" integer NOT NULL,
	"assessment_count" integer NOT NULL,
	"avg_lot_sqft" integer,
	"refreshed_at" timestamp with time zone NOT NULL
);

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

CREATE TABLE IF NOT EXISTS "api_key_audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"api_key_id" uuid,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
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
CREATE INDEX IF NOT EXISTS "api_key_audit_log_key_id_idx" ON "api_key_audit_log" USING btree ("api_key_id");
CREATE INDEX IF NOT EXISTS "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");

CREATE TABLE IF NOT EXISTS "analytics_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"route" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"consent_ts" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "analytics_events_event_created_idx" ON "analytics_events" USING btree ("event","created_at");

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
CREATE INDEX IF NOT EXISTS "attribution_events_lead_tenant_idx" ON "attribution_events" USING btree ("lead_id","tenant_key");
CREATE INDEX IF NOT EXISTS "attribution_events_status_idx" ON "attribution_events" USING btree ("status");

CREATE TABLE IF NOT EXISTS "api_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"api_key_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"estimate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "api_usage_key_id_idx" ON "api_usage" USING btree ("api_key_id");
CREATE INDEX IF NOT EXISTS "api_usage_key_created_idx" ON "api_usage" USING btree ("api_key_id","created_at");

CREATE TABLE IF NOT EXISTS "billing_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_key" text,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
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
	"dispute_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_invoices_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
CREATE TABLE IF NOT EXISTS "stripe_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "billing_events_tenant_created_idx" ON "billing_events" USING btree ("tenant_key","created_at");
CREATE INDEX IF NOT EXISTS "billing_events_entity_idx" ON "billing_events" USING btree ("entity_type","entity_id");
CREATE INDEX IF NOT EXISTS "commission_invoices_tenant_status_idx" ON "commission_invoices" USING btree ("tenant_key","status");
CREATE INDEX IF NOT EXISTS "commission_invoices_review_due_idx" ON "commission_invoices" USING btree ("review_due_at");

CREATE TABLE IF NOT EXISTS "ops_alert_state" (
	"type" text PRIMARY KEY NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_recovered_at" timestamp with time zone
);

