CREATE TABLE "estimates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"address_key" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"figures" jsonb NOT NULL,
	"rows" jsonb NOT NULL,
	"cost_data_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"estimate_id" uuid NOT NULL,
	"address_key" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"timeline" text NOT NULL,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"consent_ts" timestamp with time zone NOT NULL,
	"tenant_key" text,
	"source" text DEFAULT 'api' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "estimates_address_key_idx" ON "estimates" USING btree ("address_key");--> statement-breakpoint
CREATE INDEX "leads_address_email_created_idx" ON "leads" USING btree ("address_key","email","created_at");