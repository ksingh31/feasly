ALTER TABLE "leads" ADD COLUMN "sheets_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "leads_sheets_synced_at_idx" ON "leads" USING btree ("sheets_synced_at");--> statement-breakpoint
-- Auto-maintain updated_at on every row modification (admin/04 Sheets sync
-- uses it to detect leads changed since their last sync).
-- Exception: when ONLY sheets_synced_at changes (the sync watermark itself),
-- preserve updated_at so the row doesn't stay perpetually eligible.
CREATE OR REPLACE FUNCTION leads_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  -- Compare all columns except sheets_synced_at and updated_at.
  -- If nothing else changed, this is just a watermark stamp; keep old updated_at.
  IF (to_jsonb(NEW) - 'sheets_synced_at' - 'updated_at')
     IS NOT DISTINCT FROM
     (to_jsonb(OLD) - 'sheets_synced_at' - 'updated_at') THEN
    NEW.updated_at = OLD.updated_at;
  ELSE
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER leads_updated_at_trigger
  BEFORE UPDATE ON "leads"
  FOR EACH ROW
  EXECUTE FUNCTION leads_set_updated_at();
