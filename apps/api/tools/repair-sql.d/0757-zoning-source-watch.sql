-- #757: zoning source watch state (mirrors migration 0057).
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
ALTER TABLE "zoning_source_watch" ADD COLUMN IF NOT EXISTS "dataset_rows_updated_at" timestamp with time zone;
ALTER TABLE "zoning_source_watch" ADD COLUMN IF NOT EXISTS "bylaw_page_hash" text;
ALTER TABLE "zoning_source_watch" ADD COLUMN IF NOT EXISTS "bylaw_changed_at" timestamp with time zone;
ALTER TABLE "zoning_source_watch" ADD COLUMN IF NOT EXISTS "unknown_district_codes" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "zoning_source_watch" ADD COLUMN IF NOT EXISTS "issue_signature" text;
ALTER TABLE "zoning_source_watch" ADD COLUMN IF NOT EXISTS "issue_url" text;
ALTER TABLE "zoning_source_watch" ADD COLUMN IF NOT EXISTS "checked_at" timestamp with time zone DEFAULT now() NOT NULL;
