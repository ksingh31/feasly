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
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveDatabaseUrl } from './db-url.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const child = spawn(
  'npx',
  ['drizzle-kit', 'migrate'],
  {
    cwd: root,
    env: { ...process.env, DATABASE_URL: resolveDatabaseUrl('db:migrate') },
    stdio: 'inherit',
  },
);
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
