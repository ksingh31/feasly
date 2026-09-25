ALTER TABLE "estimates" ADD COLUMN "narrative" text;
ALTER TABLE "estimates" ADD COLUMN "narrative_generated_at" timestamp with time zone;
-- consumer/06: engine-authored assumptions (the qualitative engine→narrative
-- channel). Only renovation estimates have them; new-build rows stay null.
ALTER TABLE "estimates" ADD COLUMN "assumptions" jsonb;
