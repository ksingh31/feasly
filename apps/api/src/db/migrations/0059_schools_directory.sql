-- Schools directory (#774).
--
-- Adds the school type (public_cbe, catholic_ccsd, francophone, charter,
-- private, alternative) to the provider-fed `schools` table so the public
-- directory can filter by it. Expand only: one nullable column + index; the
-- next monthly refresh fills it.
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "school_type" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schools_type_idx" ON "schools" USING btree ("school_type");
