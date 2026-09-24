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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveDatabaseUrl() {
  const direct = process.env.DATABASE_URL;
  if (direct && direct.length > 0) return direct;
  const host = process.env.POSTGRES_HOST;
  const db = process.env.POSTGRES_DB;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const missing = [
    ['POSTGRES_HOST', host],
    ['POSTGRES_DB', db],
    ['POSTGRES_USER', user],
    ['POSTGRES_PASSWORD', password],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `db:migrate needs DATABASE_URL or all of POSTGRES_HOST/POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD (missing: ${missing.join(', ')})`,
    );
  }
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:5432/${db}?sslmode=require`;
}

const child = spawn(
  'npx',
  ['drizzle-kit', 'migrate'],
  {
    cwd: root,
    env: { ...process.env, DATABASE_URL: resolveDatabaseUrl() },
    stdio: 'inherit',
  },
);
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
