-- Neighbourhood data storage (#773).
--
-- Provider-fed tables for the Community Match epic (schools, typical
-- designations, school ratings, amenities, per-community living metrics),
-- the per-address living-metrics cache, and per-provider refresh state for
-- the monthly refresh job. Public open data only. Expand only: new tables,
-- no change to existing data.
CREATE TABLE IF NOT EXISTS "schools" (
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
	"name" text NOT NULL,
	"board" text,
	"grades" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schools_provider_idx" ON "schools" USING btree ("provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schools_community_idx" ON "schools" USING btree ("community_code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "school_designations" (
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
	"school_id" text,
	"grade_band" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "school_designations_provider_idx" ON "school_designations" USING btree ("provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "school_designations_community_idx" ON "school_designations" USING btree ("community_code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "school_ratings" (
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
	"school_id" text,
	"rating" real,
	"period" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "school_ratings_provider_idx" ON "school_ratings" USING btree ("provider");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "amenities" (
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
	"category" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "amenities_provider_idx" ON "amenities" USING btree ("provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "amenities_community_idx" ON "amenities" USING btree ("community_code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "community_living_metrics" (
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
	"metric" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "community_living_metrics_provider_idx" ON "community_living_metrics" USING btree ("provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "community_living_metrics_community_idx" ON "community_living_metrics" USING btree ("community_code","metric");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lot_living_metrics" (
	"address_key" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lot_living_metrics_expires_at_idx" ON "lot_living_metrics" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "neighbourhood_refresh_state" (
	"provider" text PRIMARY KEY NOT NULL,
	"implementation" text NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"first_failure_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"alerted_at" timestamp with time zone,
	"last_rows_changed" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
