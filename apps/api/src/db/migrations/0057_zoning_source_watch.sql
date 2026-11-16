-- Zoning source watch state (#757).
--
-- One row per city: what the daily watcher last saw of the City's Land Use
-- Districts dataset and Land Use Bylaw page, district codes the catalogue
-- doesn't know, and the signature of the last "Zoning catalogue may be out
-- of date" issue (deduplication). Public City metadata only. Expand only:
-- a new table, no change to existing data.
CREATE TABLE IF NOT EXISTS "zoning_source_watch" (
	"city" text PRIMARY KEY NOT NULL,
	"dataset_rows_updated_at" timestamp with time zone,
	"bylaw_page_hash" text,
	"bylaw_changed_at" timestamp with time zone,
	"unknown_district_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issue_signature" text,
	"issue_url" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
