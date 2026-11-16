-- Callback request: preferred day and notes (#836).
--
-- Expand only: nullable columns, no default, no backfill. Existing rows keep
-- NULL (= no preferred day / no notes). The time window already lives in
-- the `window` column.
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "preferred_date" date;--> statement-breakpoint
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "notes" text;
