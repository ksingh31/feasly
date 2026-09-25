/**
 * Analytics event persistence (story consumer/01). The interface is what
 * `AnalyticsService` depends on; unit tests fake it. The Drizzle
 * implementation is constructed once in composition.ts.
 *
 * Append-only by design: only `insert` exists. Events are immutable facts —
 * there is no update, delete, or upsert path, here or anywhere else.
 */
import type { AppDb } from '../db/client';
import { analyticsEvents } from '../db/schema';

export interface AnalyticsEventRecord {
  readonly id: string;
  readonly event: string;
  readonly route: string;
  readonly ts: Date;
  readonly consentTs: Date;
  readonly createdAt: Date;
}

export interface NewAnalyticsEvent {
  readonly id: string;
  readonly event: string;
  readonly route: string;
  readonly ts: Date;
  readonly consentTs: Date;
}

export interface AnalyticsStore {
  /**
   * Append one event. The service has already validated the shape, the
   * allowlist, and the consent gate — this method persists, nothing more.
   */
  insert(event: NewAnalyticsEvent): Promise<AnalyticsEventRecord>;
}

export function createDrizzleAnalyticsStore(deps: {
  readonly db: AppDb;
}): AnalyticsStore {
  const { db } = deps;
  return {
    async insert(event: NewAnalyticsEvent): Promise<AnalyticsEventRecord> {
      const [row] = await db
        .insert(analyticsEvents)
        .values({
          id: event.id,
          event: event.event,
          route: event.route,
          ts: event.ts,
          consentTs: event.consentTs,
        })
        .returning();
      return {
        id: row.id,
        event: row.event,
        route: row.route,
        ts: row.ts,
        consentTs: row.consentTs,
        createdAt: row.createdAt,
      };
    },
  };
}
