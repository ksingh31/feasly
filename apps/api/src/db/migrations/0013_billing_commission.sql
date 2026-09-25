CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_key" text,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_key" text NOT NULL,
	"attribution_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"contract_value_cents" integer NOT NULL,
	"commission_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"stripe_payment_intent_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"review_due_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"sla_breached" boolean DEFAULT false NOT NULL,
	"dispute_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_invoices_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD CONSTRAINT "commission_invoices_tenant_key_tenants_tenant_key_fk" FOREIGN KEY ("tenant_key") REFERENCES "public"."tenants"("tenant_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD CONSTRAINT "commission_invoices_attribution_id_attribution_events_id_fk" FOREIGN KEY ("attribution_id") REFERENCES "public"."attribution_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_invoices" ADD CONSTRAINT "commission_invoices_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_events_tenant_created_idx" ON "billing_events" USING btree ("tenant_key","created_at");--> statement-breakpoint
CREATE INDEX "billing_events_entity_idx" ON "billing_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "commission_invoices_tenant_status_idx" ON "commission_invoices" USING btree ("tenant_key","status");--> statement-breakpoint
CREATE INDEX "commission_invoices_review_due_idx" ON "commission_invoices" USING btree ("review_due_at");