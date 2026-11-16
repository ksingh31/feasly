-- Campaign attribution on leads and analytics events (#814).
--
-- Expand only: nullable columns, no default, no backfill. Existing rows keep
-- NULL (= no attribution). Leads get `source_*` columns (the existing
-- `source` column is the capture surface); analytics events get the same
-- six fields so the funnel can filter and group by utm_source / utm_campaign.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_utm_source" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_utm_medium" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_utm_campaign" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_utm_term" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_utm_content" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_click_id_type" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_source" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_medium" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_campaign" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_term" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_content" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "click_id_type" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_source_created_idx" ON "analytics_events" USING btree ("utm_source","utm_campaign","created_at");
