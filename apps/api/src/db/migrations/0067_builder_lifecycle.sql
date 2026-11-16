-- #860: builder lifecycle (suspend / reactivate / offboard).
--
-- Expand + migrate. Three nullable columns record the last status change
-- (reason, when, by whom). Legacy 'inactive' rows become 'suspended' — the
-- closest new status (no embed, no new leads); the default stays 'active'.
-- No NOT NULL tightening: every new column is legitimately null until an
-- admin first changes the status.
ALTER TABLE "builders" ADD COLUMN IF NOT EXISTS "status_reason" text;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN IF NOT EXISTS "status_changed_by" text;--> statement-breakpoint
UPDATE "builders" SET "status" = 'suspended' WHERE "status" = 'inactive';
