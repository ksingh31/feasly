-- #722: builder_agreement_acceptances (mirrors the builder_agreement_acceptances migration).
-- Idempotent; depends only on the core builders and users tables.
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
ALTER TABLE "builder_agreement_acceptances" ADD COLUMN IF NOT EXISTS "version" text NOT NULL;
ALTER TABLE "builder_agreement_acceptances" ADD COLUMN IF NOT EXISTS "accepted_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "builder_agreement_acceptances" ADD COLUMN IF NOT EXISTS "accepted_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "builder_agreement_acceptances" ADD COLUMN IF NOT EXISTS "accepted_by_email" text;
ALTER TABLE "builder_agreement_acceptances" ADD COLUMN IF NOT EXISTS "ip" text;
ALTER TABLE "builder_agreement_acceptances" ADD COLUMN IF NOT EXISTS "user_agent" text;
CREATE INDEX IF NOT EXISTS "builder_agreement_acceptances_builder_version_idx" ON "builder_agreement_acceptances" USING btree ("builder_id","version");
CREATE INDEX IF NOT EXISTS "builder_agreement_acceptances_builder_accepted_idx" ON "builder_agreement_acceptances" USING btree ("builder_id","accepted_at");
