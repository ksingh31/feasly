-- #721: lead reassignment audit table (migration 0060). Idempotent; depends
-- only on the migrations, never on another fragment.
CREATE TABLE IF NOT EXISTS "lead_reassignments" (

	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL REFERENCES "leads"("id"),
	"from_builder_id" uuid REFERENCES "builders"("id") ON DELETE SET NULL,
	"to_builder_id" uuid REFERENCES "builders"("id") ON DELETE SET NULL,
	"actor_email" text NOT NULL,
	"reassigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "lead_reassignments" ADD COLUMN IF NOT EXISTS "from_builder_id" uuid REFERENCES "builders"("id") ON DELETE SET NULL;
ALTER TABLE "lead_reassignments" ADD COLUMN IF NOT EXISTS "to_builder_id" uuid REFERENCES "builders"("id") ON DELETE SET NULL;
ALTER TABLE "lead_reassignments" ADD COLUMN IF NOT EXISTS "actor_email" text NOT NULL;
ALTER TABLE "lead_reassignments" ADD COLUMN IF NOT EXISTS "reassigned_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE INDEX IF NOT EXISTS "lead_reassignments_from_builder_idx" ON "lead_reassignments" USING btree ("from_builder_id","reassigned_at");
CREATE INDEX IF NOT EXISTS "lead_reassignments_lead_idx" ON "lead_reassignments" USING btree ("lead_id");
