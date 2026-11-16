-- Nearby building and development permits (#822).
--
-- Residential new-build BPs and DPs from City of Calgary open data, loaded
-- by the monthly neighbourhood refresh (provider 'permits'). Public permit
-- data only: the applicant is never stored. Expand only: a new table, no
-- change to existing data.
CREATE TABLE IF NOT EXISTS "permits" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"community_code" text,
	"lat" double precision,
	"lng" double precision,
	"data" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"permit_number" text NOT NULL,
	"address" text,
	"permit_type" text,
	"status" text,
	"applied_on" text,
	"decided_on" text,
	"housing_units" integer,
	"builder" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permits_provider_idx" ON "permits" USING btree ("provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permits_community_idx" ON "permits" USING btree ("community_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permits_lat_lng_idx" ON "permits" USING btree ("lat","lng");
