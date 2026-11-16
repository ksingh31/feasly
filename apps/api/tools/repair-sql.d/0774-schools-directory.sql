-- #774: schools directory type column (migration 0058). Idempotent; depends
-- only on the migrations, never on another fragment.
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "school_type" text;
CREATE INDEX IF NOT EXISTS "schools_type_idx" ON "schools" USING btree ("school_type");
