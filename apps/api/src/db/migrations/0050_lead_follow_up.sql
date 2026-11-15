-- Post-report follow-up email (#703).
--
-- `report_opened_at`: first time the homeowner opened their report with the
-- owner link (stamped once, never overwritten). `follow_up_sent_at`:
-- exactly-once guard for the follow-up email (NULL = not yet sent).
-- Expand step only: both nullable, no default, no backfill — leads that
-- opened their report before this migration simply never get a follow-up.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "report_opened_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "follow_up_sent_at" timestamp with time zone;
