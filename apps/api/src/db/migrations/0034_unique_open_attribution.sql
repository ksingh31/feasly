-- Billing double-charge backstop, part 2 (P0, 2026-09-27): one OPEN
-- introduction per lead+tenant.
--
-- The embed won flow (embed-billing-hook.chargeCommission) is
-- find-open-or-introduce: findOpenByLead → recordIntroduction. Two
-- concurrent won events for the same lead both pass the find and both
-- insert, minting TWO attributions → two invoices → two Stripe
-- PaymentIntents → the builder is charged twice for one deal. The
-- UNIQUE backstop on commission_invoices.attribution_id (0033) cannot
-- catch this because the attributions differ.
--
-- This partial index serializes the introduction itself: the loser gets
-- 23505 and recordIntroduction returns the winner's row (idempotent).
-- Only 'introduced' rows count — a lead may legitimately be re-introduced
-- after the first introduction closes (attributed / expired /
-- excluded_prior_relationship).
--
-- IF NOT EXISTS: re-running is a no-op. If open duplicates already exist
-- the CREATE fails loudly and the deploy stops — that needs human
-- investigation, not a silent pick of a winner.
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attribution_events_open_intro_unique"
  ON "attribution_events" ("lead_id", "tenant_key")
  WHERE "status" = 'introduced';
