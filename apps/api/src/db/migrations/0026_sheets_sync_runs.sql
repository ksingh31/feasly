-- admin/05: durable Sheets sync run history.
--
-- admin/04 kept the worker's run state (consecutive failures, last
-- run/success timestamps, rows synced) in process memory, which resets on
-- every Function App restart. The ops status panel needs durable,
-- restart-safe state, so every sync cycle (hourly timer + admin manual
-- trigger) records one row here.
--
-- `status` is one of: 'running' | 'success' | 'failed' | 'disabled'.
-- A run stuck in 'running' (crashed instance) is treated as stale by the
-- status service after SHEETS_RUN_STALE_AFTER_MIN minutes.
-- `error_message` holds the SANITIZED worker error text (no credentials,
-- no PII — sanitized in apps/api/src/lib/sanitize-error.ts before insert).
CREATE TABLE "sheets_sync_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "trigger" text NOT NULL,
  "actor_email" text,
  "status" text NOT NULL,
  "synced_count" integer DEFAULT 0 NOT NULL,
  "skipped_count" integer DEFAULT 0 NOT NULL,
  "error_message" text
);
--> statement-breakpoint
CREATE INDEX "sheets_sync_runs_started_at_idx" ON "sheets_sync_runs" USING btree ("started_at");
