/**
 * drizzle-kit configuration (BE1-001).
 *
 * Dev-time tooling only — never imported by src/. Migrations are generated
 * with `npm run db:generate -w @feasly/api` and applied with
 * `npm run db:migrate -w @feasly/api` (the deploy pipeline runs migrate
 * before the Functions deploy; see cd.yml).
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    // Resolved at invocation time from the environment; the migrate wrapper
    // (tools/migrate.mjs) composes a safe URL from POSTGRES_* when needed.
    url: process.env.DATABASE_URL ?? '',
  },
});
