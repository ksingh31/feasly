-- #860: builder lifecycle (mirrors migration 0067_builder_lifecycle).
ALTER TABLE "builders" ADD COLUMN IF NOT EXISTS "status_reason" text;
ALTER TABLE "builders" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamp with time zone;
ALTER TABLE "builders" ADD COLUMN IF NOT EXISTS "status_changed_by" text;
UPDATE "builders" SET "status" = 'suspended' WHERE "status" = 'inactive';
