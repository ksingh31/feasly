-- Platform agreement acceptances (#722). Expand step: new table only, no
-- change to existing data.
--
-- Append-only legal record of each clickwrap acceptance by a builder org
-- admin: version, timestamp, user id (+ email snapshot), client IP and user
-- agent. The app only inserts and reads. A builder org's "current"
-- acceptance is a row whose version equals PLATFORM_AGREEMENT_VERSION.
-- builder_id has no ON DELETE action: builders are deactivated, never
-- deleted, and the record must survive.
CREATE TABLE IF NOT EXISTS "builder_agreement_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"builder_id" uuid NOT NULL REFERENCES "builders"("id"),
	"version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"accepted_by_email" text,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_agreement_acceptances_builder_version_idx" ON "builder_agreement_acceptances" USING btree ("builder_id","version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_agreement_acceptances_builder_accepted_idx" ON "builder_agreement_acceptances" USING btree ("builder_id","accepted_at");
