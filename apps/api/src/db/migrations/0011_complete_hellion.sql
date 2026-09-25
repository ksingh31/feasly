CREATE TABLE "attribution_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"tenant_key" text NOT NULL,
	"introduced_at" timestamp with time zone NOT NULL,
	"contract_value_cents" integer,
	"contract_signed_at" timestamp with time zone,
	"status" text DEFAULT 'introduced' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attribution_events_lead_tenant_idx" ON "attribution_events" USING btree ("lead_id","tenant_key");--> statement-breakpoint
CREATE INDEX "attribution_events_status_idx" ON "attribution_events" USING btree ("status");