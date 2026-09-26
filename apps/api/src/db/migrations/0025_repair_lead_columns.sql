-- P0 repair (2026-09-26): POST /api/v1/leads 500s on live dev with
-- INTERNAL_ERROR, and POST /api/v1/magic-link/reissue 500s even for
-- unknown emails (a bare SELECT on leads). The application code is proven
-- correct against these migrations (PGlite integration test), and CD
-- reports "migrations applied successfully" — so the dev database has
-- drifted from the migration chain (e.g. a column ADD that was tracked
-- as applied but never took effect, mirroring the #133 orphaned-migration
-- incident). Every statement here is IF NOT EXISTS: on a healthy database
-- this migration is a no-op; on a drifted one it restores the columns the
-- Drizzle schema selects.
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "quarantined" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lead_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "unsubscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "nudge_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sheets_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "discarded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "email" text;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;
