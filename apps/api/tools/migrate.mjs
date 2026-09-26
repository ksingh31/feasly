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
  env: { ...process.env, DATABASE_URL: databaseUrl },
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
