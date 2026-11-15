-- Waitlist signups (#520, decision D-P4).
--
-- "Tell me when it's ready" capture for renovation estimates and for
-- cities outside Calgary (Toronto, Vancouver). Email is stored lowercased
-- + trimmed by the service; one row per (email, topic) and a repeat
-- signup is a no-op. New table only — no change to existing data.
CREATE TABLE IF NOT EXISTS "waitlist_signups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"topic" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "waitlist_signups_email_topic_idx" ON "waitlist_signups" USING btree ("email","topic");
