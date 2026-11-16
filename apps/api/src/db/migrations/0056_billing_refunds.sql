-- Admin refunds (#715). Expand step — additive only.
--
-- - `commission_invoices.refunded_cents` — running total refunded (or
--   claimed by an in-flight refund), integer cents. DEFAULT 0 so existing
--   rows need no backfill.
-- - `billing_refunds` — one row per refund (Stripe or off-Stripe), with a
--   UNIQUE client idempotency key so a retried request never creates a
--   second refund.
ALTER TABLE "commission_invoices" ADD COLUMN IF NOT EXISTS "refunded_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL REFERENCES "commission_invoices"("id"),
	"tenant_key" text NOT NULL REFERENCES "tenants"("tenant_key"),
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_refund_id" text,
	"reference" text,
	"idempotency_key" text NOT NULL,
	"actor_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_refunds_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_refunds_invoice_idx" ON "billing_refunds" USING btree ("invoice_id","created_at");
