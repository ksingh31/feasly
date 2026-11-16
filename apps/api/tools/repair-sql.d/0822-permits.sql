-- #822: nearby permits (mirrors migration 0060_permits).
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
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "provider" text NOT NULL;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "source" text NOT NULL;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "external_id" text NOT NULL;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "community_code" text;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "lat" double precision;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "lng" double precision;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "data" jsonb NOT NULL;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "content_hash" text NOT NULL;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "refreshed_at" timestamp with time zone NOT NULL;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "permit_number" text NOT NULL;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "address" text;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "permit_type" text;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "applied_on" text;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "decided_on" text;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "housing_units" integer;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "builder" text;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "permits" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE INDEX IF NOT EXISTS "permits_provider_idx" ON "permits" USING btree ("provider");
CREATE INDEX IF NOT EXISTS "permits_community_idx" ON "permits" USING btree ("community_code");
CREATE INDEX IF NOT EXISTS "permits_lat_lng_idx" ON "permits" USING btree ("lat","lng");
