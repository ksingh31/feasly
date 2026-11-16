-- #691: community lot inventory (phase 1). Mirrors migration
-- 0057_community_lots. Idempotent; depends only on the migrations — no other
-- table or fragment.
CREATE TABLE IF NOT EXISTS "community_lots" (

	"id" text PRIMARY KEY NOT NULL,
	"city" text NOT NULL,
	"community_slug" text NOT NULL,
	"roll_number" text NOT NULL,
	"address" text NOT NULL,
	"lot_sqft" integer,
	"assessed_value" integer NOT NULL,
	"roll_year" text NOT NULL,
	"district" text,
	"district_source" text NOT NULL,
	"kind" text DEFAULT 'vacant' NOT NULL,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "id" text PRIMARY KEY NOT NULL;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "city" text NOT NULL;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "community_slug" text NOT NULL;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "roll_number" text NOT NULL;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "address" text NOT NULL;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "lot_sqft" integer;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "assessed_value" integer NOT NULL;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "roll_year" text NOT NULL;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "district" text;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "district_source" text NOT NULL;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'vacant' NOT NULL;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "signals" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "latitude" double precision;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "longitude" double precision;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "community_lots" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE INDEX IF NOT EXISTS "community_lots_city_slug_idx" ON "community_lots" USING btree ("city","community_slug");
CREATE TABLE IF NOT EXISTS "community_lot_refreshes" (

	"id" text PRIMARY KEY NOT NULL,
	"city" text NOT NULL,
	"community_slug" text NOT NULL,
	"community_name" text NOT NULL,
	"roll_year" text NOT NULL,
	"lot_count" integer NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL
);
ALTER TABLE "community_lot_refreshes" ADD COLUMN IF NOT EXISTS "id" text PRIMARY KEY NOT NULL;
ALTER TABLE "community_lot_refreshes" ADD COLUMN IF NOT EXISTS "city" text NOT NULL;
ALTER TABLE "community_lot_refreshes" ADD COLUMN IF NOT EXISTS "community_slug" text NOT NULL;
ALTER TABLE "community_lot_refreshes" ADD COLUMN IF NOT EXISTS "community_name" text NOT NULL;
ALTER TABLE "community_lot_refreshes" ADD COLUMN IF NOT EXISTS "roll_year" text NOT NULL;
ALTER TABLE "community_lot_refreshes" ADD COLUMN IF NOT EXISTS "lot_count" integer NOT NULL;
ALTER TABLE "community_lot_refreshes" ADD COLUMN IF NOT EXISTS "refreshed_at" timestamp with time zone NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "community_lot_refreshes_city_slug_idx" ON "community_lot_refreshes" USING btree ("city","community_slug");
