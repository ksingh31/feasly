-- #814: campaign attribution columns (mirrors migration 0063_campaign_source).
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_utm_source" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_utm_medium" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_utm_campaign" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_utm_term" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_utm_content" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_click_id_type" text;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_source" text;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_medium" text;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_campaign" text;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_term" text;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "utm_content" text;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "click_id_type" text;
CREATE INDEX IF NOT EXISTS "analytics_events_source_created_idx" ON "analytics_events" USING btree ("utm_source","utm_campaign","created_at");
