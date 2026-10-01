-- Builder payment methods (billing/12, 2026-10-01).
--
-- `commission_invoices` gains:
-- - `invoice_number` — human-readable `INV-0001…` (`INV-` + zero-padded
--   sequence, min 4 digits), UNIQUE NOT NULL. Assigned at creation from
--   `commission_invoice_number_seq`; existing rows are backfilled in
--   `created_at` order and the sequence is advanced past them.
-- - `payment_method` — 'card' (normal Stripe auto-charge) or a manual
--   method (cheque / e_transfer / bank_draft): the builder's default
--   payment method snapshotted at invoice creation. Choosing a manual
--   method pauses the auto-charge — the invoice-reviewer timer skips
--   non-card invoices until staff marks them paid via the existing admin
--   mark-paid flow. Existing rows become 'card' (the only behavior that
--   ever existed).
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "commission_invoice_number_seq";
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN "invoice_number" text;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN "payment_method" text NOT NULL DEFAULT 'card';
--> statement-breakpoint
WITH "ordered" AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "created_at", "id") AS "rn"
  FROM "commission_invoices"
)
UPDATE "commission_invoices" "ci"
SET "invoice_number" = 'INV-' || LPAD("o"."rn"::text, 4, '0')
FROM "ordered" "o"
WHERE "ci"."id" = "o"."id";
--> statement-breakpoint
-- Advance the sequence past the backfilled rows. Skipped on an empty
-- table (MAX(rn) IS NULL): the sequence then starts at 1, so the first
-- invoice is INV-0001. setval(..., 0) is out of bounds, so it must be
-- guarded this way rather than defaulting to 0.
SELECT setval('commission_invoice_number_seq', "m"."max_n")
FROM (
  SELECT MAX("rn") AS "max_n" FROM (
    SELECT ROW_NUMBER() OVER (ORDER BY "created_at", "id") AS "rn"
    FROM "commission_invoices"
  ) "t"
) AS "m"
WHERE "m"."max_n" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ALTER COLUMN "invoice_number" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD CONSTRAINT "commission_invoices_invoice_number_unique" UNIQUE("invoice_number");
