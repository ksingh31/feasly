-- Shared City-data cache (#756).
--
-- Assessment-roll records and current land-use districts, fetched from the
-- City once and reused by every instance until expires_at (per-dataset TTL
-- in config). Public City open data only. New table only — no change to
-- existing data.
CREATE TABLE IF NOT EXISTS "city_data_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "city_data_cache_expires_at_idx" ON "city_data_cache" USING btree ("expires_at");
