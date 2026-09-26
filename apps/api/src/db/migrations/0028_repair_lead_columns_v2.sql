-- P0 repair v2 (2026-09-26): POST /api/v1/leads and
-- POST /api/v1/magic-link/reissue still 500 on live dev AFTER migration
-- 0025 applied ("migrations applied successfully", 2026-09-26 12:53:52 UTC).
-- The 0025 repair covered the drifted columns it guessed at, but the dev
-- database is missing at least one column 0025 did not cover (the app
-- selects every Drizzle schema column; any absent column -> 500).
-- Every statement here is IF NOT EXISTS: on a healthy database this
-- migration is a complete no-op; on a drifted one it restores every column
-- the Drizzle schema selects on leads, magic_links, and estimates.
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "estimate_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "address_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "email" text NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "phone" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "timeline" text NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "marketing_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "consent_ts" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "tenant_key" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "quarantined" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "discarded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lead_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "unsubscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "nudge_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sheets_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "id" uuid;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "lead_id" uuid;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'lead' NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "email" text;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "id" uuid;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "project_type" text DEFAULT 'new_build' NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "address_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "inputs" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "figures" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "rows" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "cost_data_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "narrative" text;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "narrative_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "assumptions" jsonb;
