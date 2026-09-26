CREATE TABLE "callback_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"window" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"magic_link_id" uuid,
	"partner_email" text NOT NULL,
	"sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"estimate_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"inputs" jsonb NOT NULL,
	"build_range" jsonb NOT NULL,
	"total_range" jsonb NOT NULL,
	"land_value" jsonb NOT NULL,
	"rows" jsonb NOT NULL,
	"narrative" text DEFAULT '' NOT NULL,
	"assumptions" jsonb,
	"project_type" text DEFAULT 'new_build' NOT NULL,
	"reno_inputs" jsonb,
	"version" integer NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_snapshots_estimate_version_uq" UNIQUE("estimate_id","version")
);
--> statement-breakpoint
ALTER TABLE "callback_requests" ADD CONSTRAINT "callback_requests_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_shares" ADD CONSTRAINT "partner_shares_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_shares" ADD CONSTRAINT "partner_shares_magic_link_id_magic_links_id_fk" FOREIGN KEY ("magic_link_id") REFERENCES "public"."magic_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "callback_requests_lead_id_idx" ON "callback_requests" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "partner_shares_lead_id_idx" ON "partner_shares" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "report_snapshots_estimate_id_idx" ON "report_snapshots" USING btree ("estimate_id");