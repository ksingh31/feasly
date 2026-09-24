/**
 * PGlite-backed test database (BE-3).
 *
 * Spins up an in-process Postgres, applies every migration from
 * `src/db/migrations` in journal order (the same SQL the deploy pipeline
 * runs), and hands back the drizzle client typed as `AppDb`.
 *
 * The `as unknown as AppDb` cast is deliberate and confined to this helper:
 * `drizzle-orm/pglite` and `drizzle-orm/node-postgres` expose the same
 * query-builder surface structurally; the stores only depend on that
 * surface. Production always uses the node-postgres client.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '../src/db/schema';
import type { AppDb } from '../src/db/client';

const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'db', 'migrations');

export interface TestDb {
  readonly db: AppDb;
  /** Run raw SQL, returning rows (driver-shape differences hidden here). */
  rows<T = Record<string, unknown>>(sqlText: string): Promise<T[]>;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    throw new Error(`no migration SQL found in ${MIGRATIONS_DIR}`);
  }
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // `--> statement-breakpoint` lines are comments; exec handles the batch.
    await pg.exec(sql);
  }
  const db = drizzle(pg, { schema }) as unknown as AppDb;
  return {
    db,
    rows: async <T>(sqlText: string): Promise<T[]> => {
      const result = await pg.query(sqlText);
      return result.rows as T[];
    },
    close: () => pg.close(),
  };
}
