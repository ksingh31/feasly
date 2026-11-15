-- Simulated payment provider state (#753).
--
-- Dev-only Stripe-shaped simulation (PAYMENTS_PROVIDER=simulated): one row
-- per simulated Stripe object (customer, SetupIntent, payment method,
-- PaymentIntent, refund, dispute, webhook event). No real card data. New
-- table only — no change to existing data.
CREATE TABLE IF NOT EXISTS "simulated_payment_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"object_type" text NOT NULL,
	"customer_id" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "simulated_payment_objects_customer_idx" ON "simulated_payment_objects" USING btree ("customer_id","object_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "simulated_payment_objects_type_delivered_idx" ON "simulated_payment_objects" USING btree ("object_type","delivered_at");
