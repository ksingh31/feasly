-- #773: neighbourhood data tables (migration 0057). Idempotent; depends only
-- on the migrations, never on another fragment.
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
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "provider" text NOT NULL;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "source" text NOT NULL;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "external_id" text NOT NULL;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "community_code" text;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "lat" double precision;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "lng" double precision;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "data" jsonb NOT NULL;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "content_hash" text NOT NULL;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "refreshed_at" timestamp with time zone NOT NULL;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "name" text NOT NULL;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "board" text;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "grades" text;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE INDEX IF NOT EXISTS "schools_provider_idx" ON "schools" USING btree ("provider");
CREATE INDEX IF NOT EXISTS "schools_community_idx" ON "schools" USING btree ("community_code");
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
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "provider" text NOT NULL;
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "source" text NOT NULL;
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "external_id" text NOT NULL;
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "community_code" text;
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "lat" double precision;
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "lng" double precision;
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "data" jsonb NOT NULL;
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "content_hash" text NOT NULL;
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "refreshed_at" timestamp with time zone NOT NULL;
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "school_id" text;
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "grade_band" text;
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "school_designations" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE INDEX IF NOT EXISTS "school_designations_provider_idx" ON "school_designations" USING btree ("provider");
CREATE INDEX IF NOT EXISTS "school_designations_community_idx" ON "school_designations" USING btree ("community_code");
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
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "provider" text NOT NULL;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "source" text NOT NULL;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "external_id" text NOT NULL;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "community_code" text;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "lat" double precision;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "lng" double precision;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "data" jsonb NOT NULL;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "content_hash" text NOT NULL;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "refreshed_at" timestamp with time zone NOT NULL;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "school_id" text;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "rating" real;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "period" text;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "school_ratings" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE INDEX IF NOT EXISTS "school_ratings_provider_idx" ON "school_ratings" USING btree ("provider");
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
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "provider" text NOT NULL;
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "source" text NOT NULL;
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "external_id" text NOT NULL;
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "community_code" text;
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "lat" double precision;
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "lng" double precision;
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "data" jsonb NOT NULL;
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "content_hash" text NOT NULL;
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "refreshed_at" timestamp with time zone NOT NULL;
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "category" text NOT NULL;
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "name" text NOT NULL;
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "amenities" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE INDEX IF NOT EXISTS "amenities_provider_idx" ON "amenities" USING btree ("provider");
CREATE INDEX IF NOT EXISTS "amenities_community_idx" ON "amenities" USING btree ("community_code");
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
ALTER TABLE "community_living_metrics" ADD COLUMN IF NOT EXISTS "provider" text NOT NULL;
ALTER TABLE "community_living_metrics" ADD COLUMN IF NOT EXISTS "source" text NOT NULL;
ALTER TABLE "community_living_metrics" ADD COLUMN IF NOT EXISTS "external_id" text NOT NULL;
ALTER TABLE "community_living_metrics" ADD COLUMN IF NOT EXISTS "community_code" text;
ALTER TABLE "community_living_metrics" ADD COLUMN IF NOT EXISTS "lat" double precision;
ALTER TABLE "community_living_metrics" ADD COLUMN IF NOT EXISTS "lng" double precision;
ALTER TABLE "community_living_metrics" ADD COLUMN IF NOT EXISTS "data" jsonb NOT NULL;
ALTER TABLE "community_living_metrics" ADD COLUMN IF NOT EXISTS "content_hash" text NOT NULL;
ALTER TABLE "community_living_metrics" ADD COLUMN IF NOT EXISTS "refreshed_at" timestamp with time zone NOT NULL;
ALTER TABLE "community_living_metrics" ADD COLUMN IF NOT EXISTS "metric" text NOT NULL;
ALTER TABLE "community_living_metrics" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "community_living_metrics" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE INDEX IF NOT EXISTS "community_living_metrics_provider_idx" ON "community_living_metrics" USING btree ("provider");
CREATE INDEX IF NOT EXISTS "community_living_metrics_community_idx" ON "community_living_metrics" USING btree ("community_code","metric");
CREATE TABLE IF NOT EXISTS "lot_living_metrics" (

	"address_key" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
ALTER TABLE "lot_living_metrics" ADD COLUMN IF NOT EXISTS "data" jsonb NOT NULL;
ALTER TABLE "lot_living_metrics" ADD COLUMN IF NOT EXISTS "computed_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "lot_living_metrics" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone NOT NULL;
CREATE INDEX IF NOT EXISTS "lot_living_metrics_expires_at_idx" ON "lot_living_metrics" USING btree ("expires_at");
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
ALTER TABLE "neighbourhood_refresh_state" ADD COLUMN IF NOT EXISTS "implementation" text NOT NULL;
ALTER TABLE "neighbourhood_refresh_state" ADD COLUMN IF NOT EXISTS "last_run_at" timestamp with time zone;
ALTER TABLE "neighbourhood_refresh_state" ADD COLUMN IF NOT EXISTS "last_success_at" timestamp with time zone;
ALTER TABLE "neighbourhood_refresh_state" ADD COLUMN IF NOT EXISTS "last_failure_at" timestamp with time zone;
ALTER TABLE "neighbourhood_refresh_state" ADD COLUMN IF NOT EXISTS "first_failure_at" timestamp with time zone;
ALTER TABLE "neighbourhood_refresh_state" ADD COLUMN IF NOT EXISTS "consecutive_failures" integer DEFAULT 0 NOT NULL;
ALTER TABLE "neighbourhood_refresh_state" ADD COLUMN IF NOT EXISTS "alerted_at" timestamp with time zone;
ALTER TABLE "neighbourhood_refresh_state" ADD COLUMN IF NOT EXISTS "last_rows_changed" integer DEFAULT 0 NOT NULL;
ALTER TABLE "neighbourhood_refresh_state" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "neighbourhood_refresh_state" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
