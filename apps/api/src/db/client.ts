/**
 * Drizzle client factory (BE1-001).
 *
 * The pool is constructed here and nowhere else. `drizzle()` itself is lazy —
 * no connection is opened until the first query — so building the composition
 * in tests never touches the network. Callers own `close()` (the Functions
 * adapters intentionally keep the pool warm across invocations).
 *
 * `AppDb` is the type services depend on. Tests run the same schema against
 * PGlite and cast — the drizzle query-builder surface is structural, and the
 * cast is confined to test setup with a comment at each site.
 */
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export type AppDb = NodePgDatabase<typeof schema>;

export interface DbClientDeps {
  /** Full Postgres connection string (from config — never built here). */
  readonly connectionString: string;
  /** Pool ceiling; from config. */
  readonly maxPoolSize: number;
}

export interface DbClient {
  readonly db: AppDb;
  /**
   * Liveness probe: resolves when the database answers a trivial query,
   * rejects when it doesn't. Used by the health service — never in a
   * request path.
   */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDbClient(deps: DbClientDeps): DbClient {
  const pool = new Pool({
    connectionString: deps.connectionString,
    max: deps.maxPoolSize,
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    ping: () => db.execute(sql`SELECT 1`).then(() => undefined),
    close: () => pool.end(),
  };
}
