-- Admin manual mark-paid + per-invoice commission-rate override (2026-09-29).
--
-- commission_invoices gains three nullable columns:
-- - manual_payment_method (text): the off-Stripe payment method recorded by
--   an admin mark-paid action (cheque, bank_draft, e_transfer, cash,
--   card_terminal, other). Null unless the invoice was manually marked paid.
-- - payment_reference (text): cheque/trace number for the manual payment.
--   Null otherwise.
-- - commission_rate_override (real): admin override of the commission rate,
--   in PERCENT (e.g. 1.5 = 1.5%). Null = the configured default
--   (BILLING_COMMISSION_RATE). Set only on unpaid invoices.
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN "manual_payment_method" text;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN "payment_reference" text;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN "commission_rate_override" real;
