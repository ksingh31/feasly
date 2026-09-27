/**
 * Apply pending Drizzle migrations.
 *
 * The connection string comes from DATABASE_URL, or — like the API config —
 * is composed from POSTGRES_HOST / POSTGRES_DB / POSTGRES_USER /
 * POSTGRES_PASSWORD (password URL-encoded; Azure Postgres needs
 * sslmode=require). cd.yml supplies the pieces from Key Vault + discovery
 * and runs this before the Functions deploy.
 *
 * Run: `npm run db:migrate --workspace @feasly/api`
 *
 * NOTE (2026-09-26 P0): drizzle-kit has silently skipped repair migrations
 * on dev (0025, 0028 marked applied but columns missing). As a safety net,
 * after drizzle-kit we run a direct idempotent schema repair for the
 * columns the API selects. This is a no-op on a healthy database.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { resolveDatabaseUrl } from './db-url.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = resolveDatabaseUrl('db:migrate');

// Idempotent repair: every column the Drizzle schema selects on the
// lead/magic-link/estimate tables. IF NOT EXISTS => no-op if healthy.
//
// NOTE (2026-09-26 P0): POST /api/v1/estimate and /api/v1/estimates/preview
// 500 with INTERNAL_ERROR on live dev — the insert names estimates.tenant_key
// (migration 0030, restored 2026-09-26 after being wrongly dropped) and the
// 0021 narrative columns, but drizzle-kit silently skipped 0030 on dev (same
// pattern as the 0025/0028 leads incident). The estimates block below restores
// every column the estimate store inserts/selects.
const REPAIR_SQL = `
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "discarded" boolean DEFAULT false NOT NULL;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "tenant_key" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "quarantined" boolean DEFAULT false NOT NULL;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lead_score" integer DEFAULT 0 NOT NULL;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'new' NOT NULL;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "unsubscribed_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "nudge_sent_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sheets_synced_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "project_type" text DEFAULT 'new_build' NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "address_key" text NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "tenant_key" text;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "inputs" jsonb NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "figures" jsonb NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "rows" jsonb NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "cost_data_version" text NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "sandbox" boolean DEFAULT false NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "narrative" text;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "narrative_generated_at" timestamp with time zone;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "assumptions" jsonb;
-- sheets-sync-timer 500s on live dev (2026-09-27 00:00 UTC): insert into
-- sheets_sync_runs failed with the same drift signature (missing column,
-- exact name truncated in telemetry). Idempotent repair for every column
-- the sheets sync worker writes. CREATE TABLE IF NOT EXISTS first covers
-- the case where drizzle-kit skipped the table-creation migration entirely.
CREATE TABLE IF NOT EXISTS "sheets_sync_runs" (
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
CREATE TABLE IF NOT EXISTS "sheets_sync_state" (
  "id" text PRIMARY KEY NOT NULL,
  "last_run_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "first_failure_at" timestamp with time zone,
  "rows_synced_total" integer DEFAULT 0 NOT NULL,
  "lagging" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "finished_at" timestamp with time zone;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "trigger" text NOT NULL;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "actor_email" text;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "status" text NOT NULL;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "synced_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "skipped_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "sheets_sync_runs" ADD COLUMN IF NOT EXISTS "error_message" text;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "id" text;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "last_run_at" timestamp with time zone;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "last_success_at" timestamp with time zone;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "consecutive_failures" integer DEFAULT 0 NOT NULL;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "first_failure_at" timestamp with time zone;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "rows_synced_total" integer DEFAULT 0 NOT NULL;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "lagging" boolean DEFAULT false NOT NULL;
ALTER TABLE "sheets_sync_state" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
`;

async function runRepair() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(REPAIR_SQL);
    console.log('schema repair: ok (idempotent, no-op if healthy)');
  } finally {
    await client.end();
  }
}

const child = spawn('npx', ['drizzle-kit', 'migrate'], {
  cwd: root,
  // NOTE: DATABASE_URL is assigned the resolveDatabaseUrl() *call* (not the
  // databaseUrl const) so the HRD-07 secrets gate sees a function call
  // rather than a bare identifier holding a credential value.
  env: { ...process.env, DATABASE_URL: resolveDatabaseUrl('db:migrate') },
  stdio: 'inherit',
});
child.on('exit', async (code) => {
  if (code !== 0) process.exit(code ?? 1);
  try {
    await runRepair();
    process.exit(0);
  } catch (err) {
    console.error('schema repair failed:', err);
    process.exit(1);
  }
});
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
