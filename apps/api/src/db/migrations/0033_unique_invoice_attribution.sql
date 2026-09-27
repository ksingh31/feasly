-- Billing double-charge backstop (P0, 2026-09-27): one invoice per attribution.
--
-- commission.service.createDraftInvoice and embed-billing-hook.chargeCommission
-- are check-then-act (findFirst → insert). Two concurrent won events for the
-- same deal both pass the check and both insert → two invoices + two Stripe
-- PaymentIntents → the builder is charged twice. The application code now
-- treats a 23505 on this constraint as "someone else won the race" and
-- returns the existing invoice (idempotent), but only the database can make
-- that atomic. Hence this UNIQUE backstop.
--
-- Why attribution_id and not lead_id: one attribution = one reported won
-- deal; a lead may legitimately accrue several attributions (and invoices)
-- across separate deals over time, so lead_id must stay non-unique.
--
-- Idempotent DO block (repo convention since the 0025/0028 drift repairs):
-- re-running is a no-op. If duplicate rows already exist the ALTER fails
-- loudly and the deploy stops — that needs human investigation, not a
-- silent pick of a winner.
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commission_invoices_attribution_id_unique'
  ) THEN
    ALTER TABLE "commission_invoices"
      ADD CONSTRAINT "commission_invoices_attribution_id_unique"
      UNIQUE("attribution_id");
  END IF;
END $$;
