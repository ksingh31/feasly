CREATE TABLE "erasure_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid,
	"email_hash" text NOT NULL,
	"status" text NOT NULL,
	"blockers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid,
	"purpose" text DEFAULT 'lead' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "privacy_audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "erasure_requests_email_hash_idx" ON "erasure_requests" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "magic_links_lead_id_idx" ON "magic_links" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "privacy_audit_log_lead_id_idx" ON "privacy_audit_log" USING btree ("lead_id");