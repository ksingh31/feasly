-- #718: commission invoice dunning schedule columns. Mirrors migration
-- 0057 (expand-only). Every statement is IF NOT EXISTS and depends only on
-- the core commission_invoices table, so it is order-independent.
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "retry_grace_days" integer;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "last_charge_failed_at" timestamp with time zone;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "dunning_state" text DEFAULT 'active' NOT NULL;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "collections_at" timestamp with time zone;
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "overdue_reminded_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "commission_invoices_next_retry_idx" ON "commission_invoices" USING btree ("next_retry_at");
