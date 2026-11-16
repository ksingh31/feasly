/**
 * Drizzle-backed zoning source watch state (#757).
 *
 * One row per city: what the daily watcher last saw of the City's sources
 * and the signature of the last out-of-date issue it filed. Only services
 * import this module (layer boundary: routes never touch the db).
 */
import { eq } from 'drizzle-orm';
import { zoningSourceWatch } from '../db/schema';

/** Watch state for one city. */
export interface ZoningWatchState {
  readonly city: string;
  /** Land Use Districts dataset `rowsUpdatedAt`, as last seen. */
  readonly datasetRowsUpdatedAt: Date | null;
  /** sha256 of the normalised Land Use Bylaw page text, as last seen. */
  readonly bylawPageHash: string | null;
  /** When the bylaw page was last seen to change (Last-Modified or detection time). */
  readonly bylawChangedAt: Date | null;
  /** District codes in the City dataset that the catalogue doesn't know (sorted). */
  readonly unknownDistrictCodes: readonly string[];
  /** Signature of the change the last filed issue described (dedup key). */
  readonly issueSignature: string | null;
  readonly issueUrl: string | null;
  readonly checkedAt: Date;
}

export interface ZoningWatchStore {
  get(city: string): Promise<ZoningWatchState | undefined>;
  put(state: ZoningWatchState): Promise<void>;
}

export interface DrizzleZoningWatchStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

function codesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function createDrizzleZoningWatchStore(deps: DrizzleZoningWatchStoreDeps): ZoningWatchStore {
  const { db } = deps;
  const t = zoningSourceWatch;
  return {
    async get(city): Promise<ZoningWatchState | undefined> {
      const rows: Array<typeof t.$inferSelect> = await db.select().from(t).where(eq(t.city, city)).limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return {
        city: row.city,
        datasetRowsUpdatedAt: row.datasetRowsUpdatedAt,
        bylawPageHash: row.bylawPageHash,
        bylawChangedAt: row.bylawChangedAt,
        unknownDistrictCodes: codesOf(row.unknownDistrictCodes),
        issueSignature: row.issueSignature,
        issueUrl: row.issueUrl,
        checkedAt: row.checkedAt,
      };
    },

    async put(state): Promise<void> {
      const values = {
        datasetRowsUpdatedAt: state.datasetRowsUpdatedAt,
        bylawPageHash: state.bylawPageHash,
        bylawChangedAt: state.bylawChangedAt,
        unknownDistrictCodes: [...state.unknownDistrictCodes],
        issueSignature: state.issueSignature,
        issueUrl: state.issueUrl,
        checkedAt: state.checkedAt,
      };
      await db
        .insert(t)
        .values({ city: state.city, ...values })
        .onConflictDoUpdate({ target: t.city, set: values });
    },
  };
}
