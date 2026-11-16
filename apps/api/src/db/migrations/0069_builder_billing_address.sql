-- #881: builder billing address (sent to the builder's Stripe customer).
--
-- Expand only. One nullable jsonb column — null until an admin or the
-- builder's owner enters an address. No backfill, no NOT NULL tightening.
ALTER TABLE "builders" ADD COLUMN IF NOT EXISTS "billing_address" jsonb;
