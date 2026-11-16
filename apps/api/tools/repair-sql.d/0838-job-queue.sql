-- #838: job queue + link-only shares (mirrors migration 0064_job_queue).
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lead_id" uuid REFERENCES "leads"("id") ON DELETE cascade,
	"dedupe_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_dedupe_key_idx" ON "jobs" USING btree ("dedupe_key");
CREATE INDEX IF NOT EXISTS "jobs_status_run_at_idx" ON "jobs" USING btree ("status","run_at");
CREATE INDEX IF NOT EXISTS "jobs_lead_id_idx" ON "jobs" USING btree ("lead_id");
ALTER TABLE "partner_shares" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'email' NOT NULL;
ALTER TABLE "partner_shares" ALTER COLUMN "partner_email" DROP NOT NULL;
