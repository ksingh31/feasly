-- Stripe chargebacks + dashboard refunds (#719). Expand step only: every new
-- column is nullable or carries a default, so this is safe on a live table.
--
-- billing_disputes: chargebacks share the admin disputes queue with builder
-- disputes, distinguished by `source`. Existing rows default to 'builder'.
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'builder' NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "stripe_dispute_id" text;
--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "stripe_reason" text;
--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "stripe_status" text;
--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "amount_cents" integer;
--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "evidence_due_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "outcome" text;
--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD COLUMN IF NOT EXISTS "livemode" boolean;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_disputes_stripe_dispute_id_idx" ON "billing_disputes" USING btree ("stripe_dispute_id");
--> statement-breakpoint
-- commission_invoices: chargeback flag + cumulative refunded amount.
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "chargeback_status" text;
--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "refunded_cents" integer DEFAULT 0 NOT NULL;
