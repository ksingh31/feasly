-- #881: builder billing address (mirrors migration 0069_builder_billing_address).
ALTER TABLE "builders" ADD COLUMN IF NOT EXISTS "billing_address" jsonb;
