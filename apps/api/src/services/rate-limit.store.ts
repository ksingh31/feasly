/**
 * Drizzle-backed SharedCounterStore (#729).
 *
 * Backs the cross-instance limiters in `middleware/shared-rate-limit.ts`.
 * Every hit is a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so
 * concurrent instances serialize on the row lock and the count is exact.
 *
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the db directly).
 */
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { rateLimitCounters } from '../db/schema';
import type { SharedCounterStore } from '../middleware/shared-rate-limit';

export interface DrizzleRateLimitStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

export function createDrizzleRateLimitStore(
  deps: DrizzleRateLimitStoreDeps,
): SharedCounterStore {
  const { db } = deps;
  const t = rateLimitCounters;
  return {
    async increment({ key, windowStart, expiresAt }): Promise<number> {
      const rows: Array<{ count: number }> = await db
        .insert(t)
        .values({ key, windowStart, count: 1, expiresAt })
        .onConflictDoUpdate({
          target: t.key,
          // Same (or newer, if this instance's clock lags) window: add one.
          // An older stored window: restart at 1. GREATEST keeps a lagging
          // instance from rolling the window back.
          set: {
            count: sql`CASE WHEN ${t.windowStart} >= excluded.window_start THEN ${t.count} + 1 ELSE 1 END`,
            windowStart: sql`GREATEST(${t.windowStart}, excluded.window_start)`,
            expiresAt: sql`GREATEST(${t.expiresAt}, excluded.expires_at)`,
          },
        })
        .returning({ count: t.count });
      const row = rows[0];
      if (!row) throw new Error('rate_limit_counters upsert returned no row');
      return Number(row.count);
    },

    async read(key: string, now: Date): Promise<number> {
      const rows: Array<{ count: number }> = await db
        .select({ count: t.count })
        .from(t)
        .where(and(eq(t.key, key), gt(t.expiresAt, now)))
        .limit(1);
      return rows[0] ? Number(rows[0].count) : 0;
    },

    async set({ key, windowStart, expiresAt }): Promise<void> {
      await db
        .insert(t)
        .values({ key, windowStart, count: 1, expiresAt })
        .onConflictDoUpdate({
          target: t.key,
          set: { windowStart, count: 1, expiresAt },
        });
    },

    async deleteExpired(now: Date): Promise<number> {
      const rows: unknown[] = await db
        .delete(t)
        .where(lt(t.expiresAt, now))
        .returning({ key: t.key });
      return rows.length;
    },
  };
}
