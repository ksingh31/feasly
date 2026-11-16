-- Community lot inventory, phase 1 (#691).
--
-- Vacant residential land-only parcels in established infill communities,
-- derived from City of Calgary open data by the community-lots refresh
-- timer. `community_lot_refreshes` records one row per community the last
-- refresh covered (drives the API's refreshedAt/stale and the 404 for
-- communities outside the inventory). Public City open data only — no
-- owner names, no visitor data. New tables only (expand); no change to
-- existing data.
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "community_lots_city_slug_idx" ON "community_lots" USING btree ("city","community_slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "community_lot_refreshes" (
	"id" text PRIMARY KEY NOT NULL,
	"city" text NOT NULL,
	"community_slug" text NOT NULL,
	"community_name" text NOT NULL,
	"roll_year" text NOT NULL,
	"lot_count" integer NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "community_lot_refreshes_city_slug_idx" ON "community_lot_refreshes" USING btree ("city","community_slug");
