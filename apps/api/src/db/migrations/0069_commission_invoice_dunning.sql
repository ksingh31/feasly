-- Dunning schedule (#718). Expand step only — every new column is nullable
-- or carries a default, so existing rows and running code are unaffected.
--
-- `commission_invoices` gains:
-- - `retry_grace_days` — per-invoice grace period in days; NULL = the
--   configured default (BILLING_DUNNING_GRACE_DAYS).
-- - `next_retry_at` — when the daily timer next retries a failed card charge.
-- - `last_charge_failed_at` — when the latest charge attempt failed.
-- - `dunning_state` — 'active' | 'paused' | 'cancelled' (admin control).
-- - `collections_at` — set once when the final automatic retry failed.
-- - `overdue_reminded_at` — set once when a manual-method invoice's overdue
--   reminder went out.
-- Existing failed invoices get no retry date (no surprise charges on
-- deploy); an admin "resume" schedules them.
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "retry_grace_days" integer;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "last_charge_failed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "dunning_state" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "collections_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "overdue_reminded_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_invoices_next_retry_idx" ON "commission_invoices" USING btree ("next_retry_at");
