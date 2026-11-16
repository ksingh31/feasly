-- Session idle timeout (#730).
--
-- `last_seen_at`: last time the session validated (written at most once per
-- SESSION_ACTIVITY_TOUCH_INTERVAL_SECONDS). The idle timeout measures from
-- it; NULL (rows minted before this migration) falls back to created_at.
-- Expand step only: nullable, no default, no backfill.
ALTER TABLE "admin_sessions" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "builder_sessions" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
