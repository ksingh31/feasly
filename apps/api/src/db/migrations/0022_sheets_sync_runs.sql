-- admin/05: Sheets sync run history (append-only).
-- One row per sync run (timer or manual); the status endpoint reads the
-- latest rows to compute health. The sync worker is the ONLY writer.
CREATE TABLE "sheets_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "status" text NOT NULL,
  "rows_synced" integer DEFAULT 0 NOT NULL,
  "rows_skipped" integer DEFAULT 0 NOT NULL,
  "error" text,
  "trigger" text DEFAULT 'timer' NOT NULL
);
CREATE INDEX "sheets_sync_runs_started_idx" ON "sheets_sync_runs" USING btree ("started_at");
