/**
 * Drizzle-backed UsageStore (api-mcp/07).
 *
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the db directly).
 */
import { and, count, eq, gte, lte, sql } from 'drizzle-orm';
import { apiUsage } from '../db/schema';
import type {
  UsageAggregate,
  UsageQuery,
  UsageStore,
} from './usage.service';

export interface DrizzleUsageStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

export function createDrizzleUsageStore(
  deps: DrizzleUsageStoreDeps,
): UsageStore {
  const { db } = deps;

  return {
    async insert(record): Promise<void> {
      await db.insert(apiUsage).values(record);
    },

    async countSince(apiKeyId: string, since: Date): Promise<number> {
      const rows = await db
        .select({ n: count() })
        .from(apiUsage)
        .where(
          and(
            eq(apiUsage.apiKeyId, apiKeyId),
            gte(apiUsage.createdAt, since),
          ),
        );
      return rows[0]?.n ?? 0;
    },

    async oldestSince(apiKeyId: string, since: Date): Promise<Date | null> {
      const rows = await db
        .select({ createdAt: apiUsage.createdAt })
        .from(apiUsage)
        .where(
          and(
            eq(apiUsage.apiKeyId, apiKeyId),
            gte(apiUsage.createdAt, since),
          ),
        )
        .orderBy(apiUsage.createdAt)
        .limit(1);
      return rows[0]?.createdAt ?? null;
    },

    async aggregate(query: UsageQuery): Promise<UsageAggregate[]> {
      const conditions = [];
      if (query.apiKeyId) {
        conditions.push(eq(apiUsage.apiKeyId, query.apiKeyId));
      }
      if (query.from) {
        conditions.push(gte(apiUsage.createdAt, query.from));
      }
      if (query.to) {
        conditions.push(lte(apiUsage.createdAt, query.to));
      }
      const where =
        conditions.length > 0 ? and(...conditions) : undefined;

      // Group by UTC calendar day + endpoint. estimates_created counts
      // rows where estimate_id is not null.
      const rows = await db
        .select({
          date: sql<string>`to_char(${apiUsage.createdAt}, 'YYYY-MM-DD')`,
          endpoint: apiUsage.endpoint,
          count: count(),
          estimatesCreated: sql<number>`count(${apiUsage.estimateId})`,
        })
        .from(apiUsage)
        .where(where)
        .groupBy(
          sql`to_char(${apiUsage.createdAt}, 'YYYY-MM-DD')`,
          apiUsage.endpoint,
        )
        .orderBy(
          sql`to_char(${apiUsage.createdAt}, 'YYYY-MM-DD')`,
          apiUsage.endpoint,
        );

      return rows.map((r: { date: string; endpoint: string; count: number; estimatesCreated: number }) => ({
        date: r.date,
        endpoint: r.endpoint,
        count: Number(r.count),
        estimatesCreated: Number(r.estimatesCreated),
      }));
    },
  };
}
