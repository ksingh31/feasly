-- #870: builder Settings — embed install check + origin-change requests.
--
-- Expand only. analytics_events gains a nullable `embed_origin` (the host
-- page origin on `embed_loaded`; NULL for every existing row and for every
-- other event). `builder_change_requests` is a new table: one row per
-- builder "Request a change" for allowed embed origins (an admin task).
-- The partial unique index makes an identical open request idempotent.
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "embed_origin" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_embed_origin_idx" ON "analytics_events" USING btree ("tenant_key","embed_origin","created_at") WHERE "event" = 'embed_loaded';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"builder_id" uuid NOT NULL REFERENCES "builders"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"dedupe_key" text NOT NULL,
	"requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"requested_by_email" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_change_requests_open_dedupe_idx" ON "builder_change_requests" USING btree ("builder_id","dedupe_key") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_change_requests_status_created_idx" ON "builder_change_requests" USING btree ("status","created_at");
