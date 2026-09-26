/**
 * Drizzle-backed sheets-sync worker state store (admin/04).
 *
 * Single-row table (`sheets_sync_state`, id = 'singleton') holding the
 * worker's health: last run/success timestamps, consecutive failure count,
 * lifetime rows synced, and the `lagging` flag (the `sheets_sync.lagging`
 * metric from AC4). Persisted so restarts don't reset the failure streak.
 *
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the db directly).
 */
import { eq } from 'drizzle-orm';
import { sheetsSyncState } from '../db/schema';

/** Persistent health of the hourly Sheets sync worker. */
export interface SheetsSyncStateRecord {
  readonly lastRunAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly consecutiveFailures: number;
  readonly firstFailureAt: Date | null;
  readonly rowsSyncedTotal: number;
  readonly lagging: boolean;
  readonly updatedAt: Date;
}

export interface SheetsSyncStateStore {
  /** Read the singleton row (creates it if missing). */
  get(): Promise<SheetsSyncStateRecord>;
  /**
   * Patch the singleton row. Only the provided fields change;
   * `updatedAt` is always refreshed.
   */
  update(patch: {
    readonly lastRunAt?: Date | null;
    readonly lastSuccessAt?: Date | null;
    readonly consecutiveFailures?: number;
    readonly firstFailureAt?: Date | null;
    readonly rowsSyncedTotal?: number;
    readonly lagging?: boolean;
  }): Promise<SheetsSyncStateRecord>;
}

export interface DrizzleSheetsSyncStateStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

const SINGLETON_ID = 'singleton';

function toRecord(
  row: typeof sheetsSyncState.$inferSelect,
): SheetsSyncStateRecord {
  return {
    lastRunAt: row.lastRunAt,
    lastSuccessAt: row.lastSuccessAt,
    consecutiveFailures: row.consecutiveFailures,
    firstFailureAt: row.firstFailureAt,
    rowsSyncedTotal: row.rowsSyncedTotal,
    lagging: row.lagging,
    updatedAt: row.updatedAt,
  };
}

export function createDrizzleSheetsSyncStateStore(
  deps: DrizzleSheetsSyncStateStoreDeps,
): SheetsSyncStateStore {
  const { db } = deps;
  return {
    async get(): Promise<SheetsSyncStateRecord> {
      const rows = await db
        .select()
        .from(sheetsSyncState)
        .where(eq(sheetsSyncState.id, SINGLETON_ID))
        .limit(1);
      const row = rows[0];
      if (row) return toRecord(row);
      // Fresh database where the seed didn't run — create the row.
      const inserted = await db
        .insert(sheetsSyncState)
        .values({ id: SINGLETON_ID })
        .onConflictDoNothing()
        .returning();
      const created = inserted[0];
      if (created) return toRecord(created);
      const retry = await db
        .select()
        .from(sheetsSyncState)
        .where(eq(sheetsSyncState.id, SINGLETON_ID))
        .limit(1);
      return toRecord(retry[0]);
    },

    async update(patch): Promise<SheetsSyncStateRecord> {
      // Ensure the row exists first (idempotent).
      await this.get();
      const rows = await db
        .update(sheetsSyncState)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(sheetsSyncState.id, SINGLETON_ID))
        .returning();
      return toRecord(rows[0]);
    },
  };
}
