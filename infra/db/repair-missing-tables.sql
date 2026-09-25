-- repair-missing-tables.sql
-- Idempotent repair: recreates any missing tables/columns/indexes/FKs.
-- Generated from apps/api/src/db/migrations/*.sql (origin/main).
-- Safe to run multiple times: all statements use IF NOT EXISTS or guards.

-- === 0000_far_toad ===
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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_estimate_id_estimates_id_fk') THEN
    ALTER TABLE "leads" ADD CONSTRAINT "leads_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "estimates_address_key_idx" ON "estimates" USING btree ("address_key");

CREATE INDEX IF NOT EXISTS "leads_address_email_created_idx" ON "leads" USING btree ("address_key","email","created_at");

-- === 0001_chubby_barracuda ===
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'estimates' AND column_name = 'project_type') THEN
    ALTER TABLE "estimates" ADD COLUMN "project_type" text DEFAULT 'new_build' NOT NULL;
  END IF;
END $$;

-- === 0002_dizzy_honeypot ===
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'quarantined') THEN
    ALTER TABLE "leads" ADD COLUMN "quarantined" boolean DEFAULT false NOT NULL;
  END IF;
END $$;

-- === 0003_powerful_edwin_jarvis ===
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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erasure_requests_lead_id_leads_id_fk') THEN
    ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'magic_links_lead_id_leads_id_fk') THEN
    ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "erasure_requests_email_hash_idx" ON "erasure_requests" USING btree ("email_hash");

CREATE INDEX IF NOT EXISTS "magic_links_lead_id_idx" ON "magic_links" USING btree ("lead_id");

CREATE INDEX IF NOT EXISTS "privacy_audit_log_lead_id_idx" ON "privacy_audit_log" USING btree ("lead_id");

-- === 0004_flat_firestar ===
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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'lead_score') THEN
    ALTER TABLE "leads" ADD COLUMN "lead_score" integer DEFAULT 0 NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'status') THEN
    ALTER TABLE "leads" ADD COLUMN "status" text DEFAULT 'new' NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_notes_lead_id_leads_id_fk') THEN
    ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_status_history_lead_id_leads_id_fk') THEN
    ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "lead_notes_lead_id_idx" ON "lead_notes" USING btree ("lead_id");

CREATE INDEX IF NOT EXISTS "lead_status_history_lead_id_idx" ON "lead_status_history" USING btree ("lead_id");

-- === 0005_mute_exiles ===
CREATE TABLE IF NOT EXISTS "community_stats" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"avg_assessed_value" integer NOT NULL,
	"assessment_count" integer NOT NULL,
	"avg_lot_sqft" integer,
	"refreshed_at" timestamp with time zone NOT NULL
);

-- === 0006_free_proudstar ===
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

-- === 0007_cooing_deathbird ===
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'unsubscribed_at') THEN
    ALTER TABLE "leads" ADD COLUMN "unsubscribed_at" timestamp with time zone;
  END IF;
END $$;

-- === 0008_burly_korvac ===
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'nudge_sent_at') THEN
    ALTER TABLE "leads" ADD COLUMN "nudge_sent_at" timestamp with time zone;
  END IF;
END $$;

-- === 0009_flowery_bullseye ===
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

-- === 0010_flat_power_man ===
CREATE TABLE IF NOT EXISTS "analytics_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"route" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"consent_ts" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "analytics_events_event_created_idx" ON "analytics_events" USING btree ("event","created_at");

-- === 0011_complete_hellion ===
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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attribution_events_lead_id_leads_id_fk') THEN
    ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "attribution_events_lead_tenant_idx" ON "attribution_events" USING btree ("lead_id","tenant_key");

CREATE INDEX IF NOT EXISTS "attribution_events_status_idx" ON "attribution_events" USING btree ("status");

-- === 0012_api_usage ===
CREATE TABLE IF NOT EXISTS "api_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"api_key_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"estimate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_usage_api_key_id_api_keys_id_fk') THEN
    ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "api_usage_key_id_idx" ON "api_usage" USING btree ("api_key_id");

CREATE INDEX IF NOT EXISTS "api_usage_key_created_idx" ON "api_usage" USING btree ("api_key_id","created_at");

-- === 0013_billing_commission ===
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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'stripe_customer_id') THEN
    ALTER TABLE "tenants" ADD COLUMN "stripe_customer_id" text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_invoices_tenant_key_tenants_tenant_key_fk') THEN
    ALTER TABLE "commission_invoices" ADD CONSTRAINT "commission_invoices_tenant_key_tenants_tenant_key_fk" FOREIGN KEY ("tenant_key") REFERENCES "public"."tenants"("tenant_key") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_invoices_attribution_id_attribution_events_id_fk') THEN
    ALTER TABLE "commission_invoices" ADD CONSTRAINT "commission_invoices_attribution_id_attribution_events_id_fk" FOREIGN KEY ("attribution_id") REFERENCES "public"."attribution_events"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_invoices_lead_id_leads_id_fk') THEN
    ALTER TABLE "commission_invoices" ADD CONSTRAINT "commission_invoices_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "billing_events_tenant_created_idx" ON "billing_events" USING btree ("tenant_key","created_at");

CREATE INDEX IF NOT EXISTS "billing_events_entity_idx" ON "billing_events" USING btree ("entity_type","entity_id");

CREATE INDEX IF NOT EXISTS "commission_invoices_tenant_status_idx" ON "commission_invoices" USING btree ("tenant_key","status");

CREATE INDEX IF NOT EXISTS "commission_invoices_review_due_idx" ON "commission_invoices" USING btree ("review_due_at");

-- === 0014_sandbox_columns ===
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'estimates' AND column_name = 'sandbox') THEN
    ALTER TABLE "estimates" ADD COLUMN "sandbox" boolean DEFAULT false NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'sandbox') THEN
    ALTER TABLE "leads" ADD COLUMN "sandbox" boolean DEFAULT false NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'magic_links' AND column_name = 'sandbox') THEN
    ALTER TABLE "magic_links" ADD COLUMN "sandbox" boolean DEFAULT false NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analytics_events' AND column_name = 'sandbox') THEN
    ALTER TABLE "analytics_events" ADD COLUMN "sandbox" boolean DEFAULT false NOT NULL;
  END IF;
END $$;

-- === 0015_sheets_sync_watermark ===
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'sheets_synced_at') THEN
    ALTER TABLE "leads" ADD COLUMN "sheets_synced_at" timestamp with time zone;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'updated_at') THEN
    ALTER TABLE "leads" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "leads_sheets_synced_at_idx" ON "leads" USING btree ("sheets_synced_at");

-- === 0016_ops_alert_state ===
CREATE TABLE IF NOT EXISTS "ops_alert_state" (
	"type" text PRIMARY KEY NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_recovered_at" timestamp with time zone
);

-- === 0017_funnel_tenant_key ===
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analytics_events' AND column_name = 'tenant_key') THEN
    ALTER TABLE "analytics_events" ADD COLUMN "tenant_key" text;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "analytics_events_tenant_created_idx" ON "analytics_events" USING btree ("tenant_key","created_at");

-- === 0020_admin_session_auth ===
CREATE TABLE IF NOT EXISTS "admin_allowlist" (
	"email" text PRIMARY KEY NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "admin_audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_email" text,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "admin_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"session_token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_sessions_session_token_hash_unique" UNIQUE("session_token_hash")
);

CREATE INDEX IF NOT EXISTS "admin_audit_log_action_idx" ON "admin_audit_log" USING btree ("action");

CREATE INDEX IF NOT EXISTS "admin_sessions_token_hash_idx" ON "admin_sessions" USING btree ("session_token_hash");

CREATE INDEX IF NOT EXISTS "admin_sessions_email_idx" ON "admin_sessions" USING btree ("email");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'magic_links' AND column_name = 'email') THEN
    ALTER TABLE "magic_links" ADD COLUMN "email" text;
  END IF;
END $$;

-- === 0020_admin_session_auth: seed admin allowlist (idempotent) ===
INSERT INTO "admin_allowlist" ("email", "added_by") VALUES ('karanbirsingh667@gmail.com', 'seed') ON CONFLICT ("email") DO NOTHING;
