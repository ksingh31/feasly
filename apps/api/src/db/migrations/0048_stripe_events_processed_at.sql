-- Stripe webhook reliability (#711).
--
-- `processed_at` is stamped only after the webhook handler completes, so a
-- redelivery of a claimed-but-unprocessed event (handler threw) re-runs the
-- handler instead of being treated as a duplicate. Expand step: nullable
-- column, no default. Events recorded before this migration were handled
-- under the old claim-then-dispatch contract, so backfill them as processed
-- (received_at) — they must stay duplicates on redelivery.
ALTER TABLE "stripe_events" ADD COLUMN IF NOT EXISTS "processed_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "stripe_events" SET "processed_at" = "received_at" WHERE "processed_at" IS NULL;
