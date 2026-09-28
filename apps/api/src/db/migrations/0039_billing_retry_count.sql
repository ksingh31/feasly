-- BILL-03: retry a failed commission charge.
--
-- commission_invoices gains a NOT NULL retry_count (default 0): the number
-- of off-session charge retry attempts made after the initial finalize.
-- Capped by BILLING_MAX_CHARGE_RETRIES (default 3); invoices past the cap
-- stay 'failed' for manual handling.
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;
