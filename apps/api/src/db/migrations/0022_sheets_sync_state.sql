CREATE TABLE "sheets_sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"first_failure_at" timestamp with time zone,
	"rows_synced_total" integer DEFAULT 0 NOT NULL,
	"lagging" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Seed the singleton row. The worker upserts on every cycle, so this is
-- belt-and-braces for fresh databases (the store also handles a missing row).
INSERT INTO "sheets_sync_state" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;
