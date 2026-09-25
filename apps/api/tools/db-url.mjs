/**
 * Shared database-URL resolver for apps/api tools.
 *
 * The connection string comes from DATABASE_URL, or — like the API config —
 * is composed from POSTGRES_HOST / POSTGRES_DB / POSTGRES_USER /
 * POSTGRES_PASSWORD (password URL-encoded; Azure Postgres needs
 * sslmode=require). Used by tools/migrate.mjs and
 * tools/seed-community-stats.mjs.
 */
export function resolveDatabaseUrl(toolName) {
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
      `${toolName} needs DATABASE_URL or all of POSTGRES_HOST/POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD (missing: ${missing.join(', ')})`,
    );
  }
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:5432/${db}?sslmode=require`;
}
