-- #836: callback preferred day + notes (mirrors migration 0065_callback_preferred_time).
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "preferred_date" date;
ALTER TABLE "callback_requests" ADD COLUMN IF NOT EXISTS "notes" text;
