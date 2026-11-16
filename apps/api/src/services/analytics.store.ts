/**
 * Analytics event persistence (story consumer/01). The interface is what
 * `AnalyticsService` depends on; unit tests fake it. The Drizzle
 * implementation is constructed once in composition.ts.
 *
 * Append-only by design: only `insert` exists. Events are immutable facts —
 * there is no update, delete, or upsert path, here or anywhere else.
 */
import type { AppDb } from '../db/client';
import type { ClickIdType } from '@feasly/contracts';
import type { CampaignSourceColumns } from '../lib/campaign-source';
import { analyticsEvents } from '../db/schema';

export interface AnalyticsEventRecord {
  readonly id: string;
  readonly event: string;
  readonly route: string;
  readonly ts: Date;
  readonly consentTs: Date;
  readonly tenantKey: string | null;
  /** #814: campaign attribution (all-null = none). */
  readonly source: CampaignSourceColumns;
  readonly createdAt: Date;
}

export interface NewAnalyticsEvent {
  readonly id: string;
  readonly event: string;
  readonly route: string;
  readonly ts: Date;
  readonly consentTs: Date;
  /** Tenant key for embed-attributed events; null = Feasly-direct. */
  readonly tenantKey: string | null;
  /** #814: validated campaign attribution (all-null = none). */
  readonly source: CampaignSourceColumns;
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
          tenantKey: event.tenantKey,
          utmSource: event.source.utmSource,
          utmMedium: event.source.utmMedium,
          utmCampaign: event.source.utmCampaign,
          utmTerm: event.source.utmTerm,
          utmContent: event.source.utmContent,
          clickIdType: event.source.clickIdType,
        })
        .returning();
      return {
        id: row.id,
        event: row.event,
        route: row.route,
        ts: row.ts,
        consentTs: row.consentTs,
        tenantKey: row.tenantKey,
        source: {
          utmSource: row.utmSource,
          utmMedium: row.utmMedium,
          utmCampaign: row.utmCampaign,
          utmTerm: row.utmTerm,
          utmContent: row.utmContent,
          // Written only from the validated ClickIdType union above.
          clickIdType: row.clickIdType as ClickIdType | null,
        },
        createdAt: row.createdAt,
      };
    },
  };
}
