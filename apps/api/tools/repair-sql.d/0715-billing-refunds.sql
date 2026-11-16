-- #715: billing_refunds ledger (mirrors the billing_refunds migration). Idempotent;
-- depends only on the core commission_invoices table.
CREATE TABLE IF NOT EXISTS "billing_refunds" (

	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"tenant_key" text NOT NULL,
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY NOT NULL;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "invoice_id" uuid NOT NULL;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "tenant_key" text NOT NULL;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "amount_cents" integer NOT NULL;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'CAD' NOT NULL;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "reason" text NOT NULL;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "method" text NOT NULL;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending' NOT NULL;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "stripe_refund_id" text;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "reference" text;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "idempotency_key" text NOT NULL;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "actor_email" text;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "billing_refunds" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "billing_refunds_idempotency_key_unique" ON "billing_refunds" USING btree ("idempotency_key");
CREATE INDEX IF NOT EXISTS "billing_refunds_invoice_idx" ON "billing_refunds" USING btree ("invoice_id","created_at");
