-- Building-form choice (#689).
--
-- Expand step only: nullable columns, no default, no backfill.
-- * estimates.building_form — the form the person asked for (contracts
--   `BuildingForm`); NULL = none named (single-detached, as before).
-- * waitlist_signups.building_form / district / community — interest in a
--   form the engine does not price yet, with the lot's district + community.
--   NULL on renovation / city signups.
-- The waitlist key widens from (email, topic) to (email, topic, form) so one
-- person can ask about several forms; NULL forms still collide (COALESCE),
-- so renovation / city signups keep their one-row-per-topic guarantee. The
-- new index is created before the old one is dropped: no window without a key.
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "building_form" text;
--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD COLUMN IF NOT EXISTS "building_form" text;
--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD COLUMN IF NOT EXISTS "district" text;
--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD COLUMN IF NOT EXISTS "community" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "waitlist_signups_email_topic_form_idx" ON "waitlist_signups" USING btree ("email","topic",COALESCE("building_form", ''));
--> statement-breakpoint
DROP INDEX IF EXISTS "waitlist_signups_email_topic_idx";
