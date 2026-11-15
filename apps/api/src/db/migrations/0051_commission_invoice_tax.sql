-- GST on commission invoices (#714). Expand step.
--
-- `commission_invoices` gains the sales-tax snapshot taken at creation:
-- - `tax_rate_percent` — rate in PERCENT (5 = 5% GST); 0 = no tax.
-- - `tax_inclusive` — false = commission plus tax (default), true = the
--   commission includes tax.
-- - `tax_cents` — tax amount, integer cents.
-- - `total_cents` — commission + tax, the amount charged. Nullable in this
--   expand step; existing rows are backfilled with zero tax
--   (total = commission). A later contract step may tighten it to NOT NULL.
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "tax_rate_percent" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "tax_inclusive" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "tax_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "total_cents" integer;
--> statement-breakpoint
UPDATE "commission_invoices" SET "total_cents" = "commission_cents" + "tax_cents" WHERE "total_cents" IS NULL;
