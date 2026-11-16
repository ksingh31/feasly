/**
 * Drizzle-backed neighbourhood data store (#773).
 *
 * - `replaceSnapshot`: writes one provider's full snapshot in ONE
 *   transaction — upsert by `${source}:${externalId}`, counting only rows
 *   whose content changed, then prune that provider's rows the snapshot no
 *   longer contains. A throw anywhere rolls back: the previous data stays.
 * - Refresh state (one row per provider) for schedule, resume and alerting.
 * - Read queries for the read service, and the per-address metrics cache.
 *
 * Only services import from this module (layer boundary: routes never touch
 * the db directly).
 */
import { createHash } from 'node:crypto';
import { and, eq, getTableColumns, gt, gte, lte, ne, or, sql } from 'drizzle-orm';
import {
  amenities,
  communityLivingMetrics,
  lotLivingMetrics,
  neighbourhoodRefreshState,
  permits,
  schoolDesignations,
  schoolRatings,
  schools,
} from '../../db/schema';
import type {
  AmenityRecord,
  CommunityMetricRecord,
  NeighbourhoodProviderName,
  NeighbourhoodRecordBase,
  PermitRecord,
  SchoolDesignationRecord,
  SchoolRatingRecord,
  SchoolRecord,
} from './providers';
import { TREE_COVER_CATEGORY } from './categories';

/** Provider → the record shape it writes. */
export interface NeighbourhoodRecordMap {
  'school-directory': SchoolRecord;
  'school-designation': SchoolDesignationRecord;
  'school-ratings': SchoolRatingRecord;
  reviews: CommunityMetricRecord;
  amenities: AmenityRecord;
  commute: CommunityMetricRecord;
  permits: PermitRecord;
}

export interface SnapshotWriteResult {
  /** Rows inserted or whose content changed. */
  readonly rowsChanged: number;
  /** Rows of this provider removed because the snapshot no longer has them. */
  readonly rowsPruned: number;
  /** Rows in the snapshot. */
  readonly rowsTotal: number;
}

export interface NeighbourhoodRefreshState {
  readonly provider: NeighbourhoodProviderName;
  readonly implementation: string;
  readonly lastRunAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly firstFailureAt: Date | null;
  readonly consecutiveFailures: number;
  readonly alertedAt: Date | null;
  readonly lastRowsChanged: number;
  readonly lastError: string | null;
}

export interface StoredSchool {
  readonly id: string;
  readonly name: string;
  readonly board: string | null;
  readonly grades: string | null;
  readonly lat: number;
  readonly lng: number;
}

export interface StoredAmenity {
  readonly id: string;
  readonly category: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
}

/**
 * #777: an established community's anchor — its `tree-cover` amenity row
 * (centre point + public-tree cover data).
 */
export interface StoredCommunityAnchor {
  readonly communityCode: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly data: unknown;
  readonly refreshedAt: Date;
}

export interface StoredCommunityMetric {
  readonly metric: string;
  readonly source: string;
  readonly data: unknown;
  readonly refreshedAt: Date;
}

/** #822: a stored building / development permit. */
export interface StoredPermit {
  readonly kind: 'building' | 'development';
  readonly permitNumber: string;
  readonly address: string | null;
  readonly permitType: string | null;
  readonly status: string | null;
  readonly appliedOn: string | null;
  readonly decidedOn: string | null;
  readonly housingUnits: number | null;
  readonly builder: string | null;
  readonly communityCode: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly data: unknown;
}

/** Bounding box (degrees) for the coarse SQL filter before exact distance. */
export interface BoundingBox {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLng: number;
  readonly maxLng: number;
}

export interface NeighbourhoodDataStore {
  replaceSnapshot<P extends NeighbourhoodProviderName>(
    provider: P,
    source: string,
    records: readonly NeighbourhoodRecordMap[P][],
    refreshedAt: Date,
  ): Promise<SnapshotWriteResult>;
  getState(provider: NeighbourhoodProviderName): Promise<NeighbourhoodRefreshState | null>;
  listStates(): Promise<readonly NeighbourhoodRefreshState[]>;
  saveState(state: NeighbourhoodRefreshState): Promise<void>;
  schoolsIn(box: BoundingBox): Promise<readonly StoredSchool[]>;
  /** Point amenities in the box (never the per-community tree-cover rows). */
  amenitiesIn(box: BoundingBox): Promise<readonly StoredAmenity[]>;
  /** #777: anchor by City community code (upper) or slug (lower); null when unknown. */
  communityAnchor(codeOrSlug: string): Promise<StoredCommunityAnchor | null>;
  communityMetrics(communityCode: string): Promise<readonly StoredCommunityMetric[]>;
  /** #822: permits located in the box. */
  permitsIn(box: BoundingBox): Promise<readonly StoredPermit[]>;
  /** #822: permits of one community, by City code (upper) or slug (lower). */
  communityPermits(codeOrSlug: string): Promise<readonly StoredPermit[]>;
  getLotMetrics(addressKey: string, now: Date): Promise<unknown>;
  putLotMetrics(addressKey: string, data: unknown, computedAt: Date, expiresAt: Date): Promise<void>;
}

/** Upsert batch size (keeps statements well under the bind-parameter cap). */
const BATCH_SIZE = 500;

/** Deterministic JSON (sorted keys) so the content hash is stable. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function baseRow(
  provider: NeighbourhoodProviderName,
  source: string,
  record: NeighbourhoodRecordBase,
  typed: Record<string, unknown>,
  refreshedAt: Date,
): Record<string, unknown> {
  const content = {
    communityCode: record.communityCode ?? null,
    lat: record.lat ?? null,
    lng: record.lng ?? null,
    data: record.data,
    ...typed,
  };
  return {
    id: `${source}:${record.externalId}`,
    provider,
    source,
    externalId: record.externalId,
    ...content,
    contentHash: createHash('sha256').update(stableJson(content)).digest('hex'),
    refreshedAt,
    updatedAt: refreshedAt,
  };
}

/** Provider → target table and its typed columns. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = any;
const TARGETS: {
  readonly [P in NeighbourhoodProviderName]: {
    readonly table: AnyTable;
    readonly typed: (record: NeighbourhoodRecordMap[P]) => Record<string, unknown>;
  };
} = {
  'school-directory': {
    table: schools,
    typed: (r) => ({ name: r.name, board: r.board, grades: r.grades }),
  },
  'school-designation': {
    table: schoolDesignations,
    typed: (r) => ({ schoolId: r.schoolRef, gradeBand: r.gradeBand }),
  },
  'school-ratings': {
    table: schoolRatings,
    typed: (r) => ({ schoolId: r.schoolRef, rating: r.rating, period: r.period }),
  },
  reviews: { table: communityLivingMetrics, typed: () => ({ metric: 'reviews' }) },
  amenities: {
    table: amenities,
    typed: (r) => ({ category: r.category, name: r.name }),
  },
  commute: { table: communityLivingMetrics, typed: () => ({ metric: 'commute' }) },
  permits: {
    table: permits,
    typed: (r) => ({
      kind: r.kind,
      permitNumber: r.permitNumber,
      address: r.address,
      permitType: r.permitType,
      status: r.status,
      appliedOn: r.appliedOn,
      decidedOn: r.decidedOn,
      housingUnits: r.housingUnits,
      builder: r.builder,
    }),
  },
};

const PERMIT_COLUMNS = {
  kind: permits.kind,
  permitNumber: permits.permitNumber,
  address: permits.address,
  permitType: permits.permitType,
  status: permits.status,
  appliedOn: permits.appliedOn,
  decidedOn: permits.decidedOn,
  housingUnits: permits.housingUnits,
  builder: permits.builder,
  communityCode: permits.communityCode,
  lat: permits.lat,
  lng: permits.lng,
  data: permits.data,
};

function toState(row: typeof neighbourhoodRefreshState.$inferSelect): NeighbourhoodRefreshState {
  return {
    provider: row.provider as NeighbourhoodProviderName,
    implementation: row.implementation,
    lastRunAt: row.lastRunAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    firstFailureAt: row.firstFailureAt,
    consecutiveFailures: row.consecutiveFailures,
    alertedAt: row.alertedAt,
    lastRowsChanged: row.lastRowsChanged,
    lastError: row.lastError,
  };
}

export interface DrizzleNeighbourhoodDataStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

export function createDrizzleNeighbourhoodDataStore(
  deps: DrizzleNeighbourhoodDataStoreDeps,
): NeighbourhoodDataStore {
  const { db } = deps;

  return {
    async replaceSnapshot(provider, source, records, refreshedAt): Promise<SnapshotWriteResult> {
      const target = TARGETS[provider];
      const table = target.table;
      const typed = target.typed as (record: NeighbourhoodRecordBase) => Record<string, unknown>;
      // Last write wins on a duplicated external id within one snapshot.
      const rowsById = new Map<string, Record<string, unknown>>();
      for (const record of records) {
        const row = baseRow(provider, source, record, typed(record), refreshedAt);
        rowsById.set(row['id'] as string, row);
      }
      const rows = [...rowsById.values()];
      const ids = rows.map((row) => row['id'] as string);

      // Columns refreshed on a content change: everything but the key and
      // the creation time.
      const columns = getTableColumns(table) as Record<string, { name: string }>;
      const updateSet: Record<string, unknown> = {};
      for (const [key, column] of Object.entries(columns)) {
        if (key === 'id' || key === 'createdAt') continue;
        updateSet[key] = sql.raw(`excluded."${column.name}"`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return db.transaction(async (tx: any) => {
        let rowsChanged = 0;
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          const changed: unknown[] = await tx
            .insert(table)
            .values(batch)
            .onConflictDoUpdate({
              target: table.id,
              set: updateSet,
              setWhere: sql`${table.contentHash} IS DISTINCT FROM excluded."content_hash"`,
            })
            .returning({ id: table.id });
          rowsChanged += changed.length;
        }
        const pruned: unknown[] = await tx
          .delete(table)
          .where(
            and(
              eq(table.provider, provider),
              ids.length > 0
                ? sql`NOT (${table.id} = ANY(${sql.param(ids)}::text[]))`
                : sql`TRUE`,
            ),
          )
          .returning({ id: table.id });
        return { rowsChanged, rowsPruned: pruned.length, rowsTotal: rows.length };
      });
    },

    async getState(provider): Promise<NeighbourhoodRefreshState | null> {
      const rows = await db
        .select()
        .from(neighbourhoodRefreshState)
        .where(eq(neighbourhoodRefreshState.provider, provider))
        .limit(1);
      return rows[0] ? toState(rows[0]) : null;
    },

    async listStates(): Promise<readonly NeighbourhoodRefreshState[]> {
      const rows = await db.select().from(neighbourhoodRefreshState);
      return rows.map(toState);
    },

    async saveState(state): Promise<void> {
      const values = { ...state, updatedAt: new Date() };
      const { provider: _provider, ...set } = values;
      await db
        .insert(neighbourhoodRefreshState)
        .values(values)
        .onConflictDoUpdate({ target: neighbourhoodRefreshState.provider, set });
    },

    async schoolsIn(box): Promise<readonly StoredSchool[]> {
      const t = schools;
      return db
        .select({ id: t.id, name: t.name, board: t.board, grades: t.grades, lat: t.lat, lng: t.lng })
        .from(t)
        .where(
          and(gte(t.lat, box.minLat), lte(t.lat, box.maxLat), gte(t.lng, box.minLng), lte(t.lng, box.maxLng)),
        );
    },

    async amenitiesIn(box): Promise<readonly StoredAmenity[]> {
      const t = amenities;
      return db
        .select({ id: t.id, category: t.category, name: t.name, lat: t.lat, lng: t.lng })
        .from(t)
        .where(
          and(
            gte(t.lat, box.minLat),
            lte(t.lat, box.maxLat),
            gte(t.lng, box.minLng),
            lte(t.lng, box.maxLng),
            ne(t.category, TREE_COVER_CATEGORY),
          ),
        );
    },

    async communityAnchor(codeOrSlug): Promise<StoredCommunityAnchor | null> {
      const t = amenities;
      const key = codeOrSlug.trim();
      const rows: Array<{
        communityCode: string | null;
        name: string;
        lat: number | null;
        lng: number | null;
        data: unknown;
        refreshedAt: Date;
      }> = await db
        .select({
          communityCode: t.communityCode,
          name: t.name,
          lat: t.lat,
          lng: t.lng,
          data: t.data,
          refreshedAt: t.refreshedAt,
        })
        .from(t)
        .where(
          and(
            eq(t.category, TREE_COVER_CATEGORY),
            or(eq(t.communityCode, key.toUpperCase()), sql`${t.data}->>'slug' = ${key.toLowerCase()}`),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row || !row.communityCode || row.lat === null || row.lng === null) return null;
      return {
        communityCode: row.communityCode,
        name: row.name,
        lat: row.lat,
        lng: row.lng,
        data: row.data,
        refreshedAt: row.refreshedAt,
      };
    },

    async communityMetrics(communityCode): Promise<readonly StoredCommunityMetric[]> {
      const t = communityLivingMetrics;
      return db
        .select({ metric: t.metric, source: t.source, data: t.data, refreshedAt: t.refreshedAt })
        .from(t)
        .where(eq(t.communityCode, communityCode));
    },

    async permitsIn(box): Promise<readonly StoredPermit[]> {
      const t = permits;
      return db
        .select(PERMIT_COLUMNS)
        .from(t)
        .where(
          and(gte(t.lat, box.minLat), lte(t.lat, box.maxLat), gte(t.lng, box.minLng), lte(t.lng, box.maxLng)),
        );
    },

    async communityPermits(codeOrSlug): Promise<readonly StoredPermit[]> {
      const t = permits;
      const key = codeOrSlug.trim();
      return db
        .select(PERMIT_COLUMNS)
        .from(t)
        .where(or(eq(t.communityCode, key.toUpperCase()), sql`${t.data}->>'slug' = ${key.toLowerCase()}`));
    },

    async getLotMetrics(addressKey, now): Promise<unknown> {
      const t = lotLivingMetrics;
      const rows: Array<{ data: unknown }> = await db
        .select({ data: t.data })
        .from(t)
        .where(and(eq(t.addressKey, addressKey), gt(t.expiresAt, now)))
        .limit(1);
      return rows[0]?.data;
    },

    async putLotMetrics(addressKey, data, computedAt, expiresAt): Promise<void> {
      const t = lotLivingMetrics;
      await db
        .insert(t)
        .values({ addressKey, data, computedAt, expiresAt })
        .onConflictDoUpdate({ target: t.addressKey, set: { data, computedAt, expiresAt } });
    },
  };
}
