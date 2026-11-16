/**
 * Builder Settings persistence (#870).
 *
 * - `builder_change_requests`: builder-filed admin tasks. Today one kind,
 *   `embed_origins`. Inserting is idempotent per (builder, dedupe key)
 *   while the request is open (partial unique index), so a double submit
 *   creates exactly one task.
 * - Last `embed_loaded` per origin, read from `analytics_events` (server
 *   `created_at`, never the client clock; sandbox rows excluded).
 *
 * Only services and composition.ts import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, max } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { analyticsEvents, builderChangeRequests } from '../db/schema';

export type ChangeRequestStatus = 'open' | 'done' | 'dismissed';

export interface OriginChangeRequestRecord {
  readonly id: string;
  readonly builderId: string;
  readonly status: ChangeRequestStatus;
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly note: string | null;
  readonly createdAt: Date;
}

export interface NewOriginChangeRequest {
  readonly builderId: string;
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly note: string | null;
  readonly dedupeKey: string;
  readonly requestedByUserId: string | null;
  readonly requestedByEmail: string;
}

export interface EmbedOriginLastSeen {
  readonly origin: string;
  readonly lastSeenAt: Date;
}

export interface BuilderSettingsStore {
  /**
   * Insert an open origin-change request unless an identical one is open.
   * `created` false = the existing open request is returned untouched.
   */
  createOriginRequest(
    input: NewOriginChangeRequest,
  ): Promise<{ readonly record: OriginChangeRequestRecord; readonly created: boolean }>;
  /** Open origin-change requests for a builder, oldest first. */
  listOpenOriginRequests(builderId: string): Promise<readonly OriginChangeRequestRecord[]>;
  /** Mark requests done (staff applied the change). Returns rows updated. */
  markOriginRequestsDone(
    ids: readonly string[],
    resolvedByEmail: string,
    at: Date,
  ): Promise<number>;
  /**
   * #860: file an open "close my account" request (kind `account_closure`)
   * unless one is already open for the builder. `created` false = the
   * existing open request is returned untouched.
   */
  createClosureRequest(input: {
    readonly builderId: string;
    readonly note: string | null;
    readonly requestedByUserId: string | null;
    readonly requestedByEmail: string;
  }): Promise<{
    readonly record: { readonly id: string; readonly createdAt: Date };
    readonly created: boolean;
  }>;
  /** Most recent `embed_loaded` per origin for a tenant, limited to `origins`. */
  lastEmbedLoads(
    tenantKey: string,
    origins: readonly string[],
  ): Promise<readonly EmbedOriginLastSeen[]>;
}

const KIND_EMBED_ORIGINS = 'embed_origins';
/** #860: one open closure request per builder (fixed dedupe key). */
const KIND_ACCOUNT_CLOSURE = 'account_closure';

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function toRecord(row: typeof builderChangeRequests.$inferSelect): OriginChangeRequestRecord {
  const payload = row.payload ?? {};
  const status: ChangeRequestStatus =
    row.status === 'done' || row.status === 'dismissed' ? row.status : 'open';
  return {
    id: row.id,
    builderId: row.builderId,
    status,
    add: stringList(payload['add']),
    remove: stringList(payload['remove']),
    note: row.note,
    createdAt: row.createdAt,
  };
}

export function createDrizzleBuilderSettingsStore(deps: {
  readonly db: AppDb;
}): BuilderSettingsStore {
  const { db } = deps;

  async function findOpen(builderId: string, dedupeKey: string) {
    const rows = await db
      .select()
      .from(builderChangeRequests)
      .where(
        and(
          eq(builderChangeRequests.builderId, builderId),
          eq(builderChangeRequests.dedupeKey, dedupeKey),
          eq(builderChangeRequests.status, 'open'),
        ),
      )
      .limit(1);
    return rows[0];
  }

  return {
    async createOriginRequest(input) {
      const inserted = await db
        .insert(builderChangeRequests)
        .values({
          id: randomUUID(),
          builderId: input.builderId,
          kind: KIND_EMBED_ORIGINS,
          status: 'open',
          payload: { add: [...input.add], remove: [...input.remove] },
          note: input.note,
          dedupeKey: input.dedupeKey,
          requestedByUserId: input.requestedByUserId,
          requestedByEmail: input.requestedByEmail,
        })
        // The partial unique index (builder_id, dedupe_key) WHERE open
        // turns a concurrent duplicate into a no-op instead of a 500.
        .onConflictDoNothing()
        .returning();
      const row = inserted[0];
      if (row) return { record: toRecord(row), created: true };
      const existing = await findOpen(input.builderId, input.dedupeKey);
      if (!existing) throw new Error('builder_change_requests insert returned no row');
      return { record: toRecord(existing), created: false };
    },

    async createClosureRequest(input) {
      const inserted = await db
        .insert(builderChangeRequests)
        .values({
          id: randomUUID(),
          builderId: input.builderId,
          kind: KIND_ACCOUNT_CLOSURE,
          status: 'open',
          payload: {},
          note: input.note,
          dedupeKey: KIND_ACCOUNT_CLOSURE,
          requestedByUserId: input.requestedByUserId,
          requestedByEmail: input.requestedByEmail,
        })
        .onConflictDoNothing()
        .returning();
      const row = inserted[0];
      if (row) return { record: { id: row.id, createdAt: row.createdAt }, created: true };
      const existing = await findOpen(input.builderId, KIND_ACCOUNT_CLOSURE);
      if (!existing) throw new Error('builder_change_requests insert returned no row');
      return { record: { id: existing.id, createdAt: existing.createdAt }, created: false };
    },

    async listOpenOriginRequests(builderId) {
      const rows = await db
        .select()
        .from(builderChangeRequests)
        .where(
          and(
            eq(builderChangeRequests.builderId, builderId),
            eq(builderChangeRequests.kind, KIND_EMBED_ORIGINS),
            eq(builderChangeRequests.status, 'open'),
          ),
        )
        .orderBy(asc(builderChangeRequests.createdAt));
      return rows.map(toRecord);
    },

    async markOriginRequestsDone(ids, resolvedByEmail, at) {
      if (ids.length === 0) return 0;
      const rows = await db
        .update(builderChangeRequests)
        .set({ status: 'done', resolvedAt: at, resolvedByEmail, updatedAt: at })
        .where(
          and(
            inArray(builderChangeRequests.id, [...ids]),
            eq(builderChangeRequests.status, 'open'),
          ),
        )
        .returning({ id: builderChangeRequests.id });
      return rows.length;
    },

    async lastEmbedLoads(tenantKey, origins) {
      if (origins.length === 0) return [];
      const rows = await db
        .select({
          origin: analyticsEvents.embedOrigin,
          lastSeenAt: max(analyticsEvents.createdAt),
        })
        .from(analyticsEvents)
        .where(
          and(
            eq(analyticsEvents.event, 'embed_loaded'),
            eq(analyticsEvents.tenantKey, tenantKey),
            eq(analyticsEvents.sandbox, false),
            isNotNull(analyticsEvents.embedOrigin),
            inArray(analyticsEvents.embedOrigin, [...origins]),
          ),
        )
        .groupBy(analyticsEvents.embedOrigin);
      const out: EmbedOriginLastSeen[] = [];
      for (const r of rows) {
        if (r.origin === null || r.lastSeenAt === null) continue;
        // max() over timestamptz can come back as a string on some drivers.
        const at = r.lastSeenAt instanceof Date ? r.lastSeenAt : new Date(String(r.lastSeenAt));
        if (!Number.isNaN(at.getTime())) out.push({ origin: r.origin, lastSeenAt: at });
      }
      return out;
    },
  };
}
