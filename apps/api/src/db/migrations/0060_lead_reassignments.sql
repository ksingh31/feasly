-- Lead reassignments (#721).
--
-- One row each time an admin moves a lead away from a builder. The builder
-- portal reads it to show the old builder the lead as "Reassigned by
-- Feasly". New table only: no change to existing data.
CREATE TABLE IF NOT EXISTS "lead_reassignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL REFERENCES "leads"("id"),
	"from_builder_id" uuid REFERENCES "builders"("id") ON DELETE SET NULL,
	"to_builder_id" uuid REFERENCES "builders"("id") ON DELETE SET NULL,
	"actor_email" text NOT NULL,
	"reassigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_reassignments_from_builder_idx" ON "lead_reassignments" USING btree ("from_builder_id","reassigned_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_reassignments_lead_idx" ON "lead_reassignments" USING btree ("lead_id");
