-- Shared rate-limit counters (#729).
--
-- Per-instance in-memory limiters multiply with Functions scale-out; the
-- money/mail endpoints count here so their limits hold across instances.
-- Keys are `<scope>:<sha256>` — no raw IP or email is stored. New table
-- only — no change to existing data.
CREATE TABLE IF NOT EXISTS "rate_limit_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_counters_expires_at_idx" ON "rate_limit_counters" USING btree ("expires_at");
