-- Builder notifications (#725).
--
-- `builder_notification_preferences`: one row per (user, builder org) once a
-- member saves preferences. No row = the defaults (owner decision
-- 2026-11-15): new-lead email ON, daily digest OFF, billing email ON.
--
-- `builder_notifications`: send-once outbox for builder emails. One row per
-- (kind, lead or day, builder, recipient), keyed by `dedupe_key` (unique) so
-- a resubmitted lead or a repeated assignment never emails twice. Rows
-- start 'pending'; delivery stamps 'sent', 'skipped' (recipient opted out,
-- lead reassigned, etc.) or leaves them 'pending' for the retry timer until
-- attempts run out ('failed'). No PII: ids and an error code only.
--
-- Expand step only: two new tables, no change to existing data.
CREATE TABLE IF NOT EXISTS "builder_notification_preferences" (
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"builder_id" uuid NOT NULL REFERENCES "builders"("id") ON DELETE CASCADE,
	"new_lead_email" boolean DEFAULT true NOT NULL,
	"needs_you_digest" boolean DEFAULT false NOT NULL,
	"billing_email" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("user_id", "builder_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_notification_preferences_builder_idx" ON "builder_notification_preferences" USING btree ("builder_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"builder_id" uuid NOT NULL REFERENCES "builders"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"lead_id" uuid REFERENCES "leads"("id") ON DELETE CASCADE,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_attempt_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_notifications_dedupe_key_idx" ON "builder_notifications" USING btree ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_notifications_status_created_idx" ON "builder_notifications" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_notifications_lead_idx" ON "builder_notifications" USING btree ("lead_id");
