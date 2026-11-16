-- Outbound email queue for the daily email cap (#750).
--
-- Over-cap mail waits here until the next day's budget opens; the
-- email-outbox timer sends it oldest-first and deletes each row once sent.
-- Rows hold a recipient address, so unsent rows are dropped after
-- EMAIL_OUTBOX_MAX_AGE_HOURS. New table only — no change to existing data.
CREATE TABLE IF NOT EXISTS "email_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"body_text" text NOT NULL,
	"headers" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_outbox_created_at_idx" ON "email_outbox" USING btree ("created_at");
