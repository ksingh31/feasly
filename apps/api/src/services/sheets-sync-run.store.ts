/**
 * Drizzle-backed SheetsSyncRunStore (admin/05).
 *
 * Durable run history for the Sheets sync worker (admin/04). Every sync
 * cycle — hourly timer or admin manual trigger — records one row in
 * `sheets_sync_runs`, so the ops panel survives Function App restarts
 * (admin/04's in-memory counters did not).
 *
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the db directly).
 */
import { randomUUID } from 'node:crypto';
import { desc, eq, gt, and, sql } from 'drizzle-orm';
import { sheetsSyncRuns } from '../db/schema';

export type SheetsSyncRunTrigger = 'timer' | 'manual';
export type SheetsSyncRunStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'disabled';

export interface SheetsSyncRunRecord {
  readonly id: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly trigger: SheetsSyncRunTrigger;
  readonly actorEmail: string | null;
  readonly status: SheetsSyncRunStatus;
  readonly syncedCount: number;
  readonly skippedCount: number;
  /** Sanitized error text (no credentials, no PII) — null on success. */
  readonly errorMessage: string | null;
}

export interface SheetsSyncRunStore {
  /** Insert a 'running' row at the start of a cycle. */
  startRun(args: {
    readonly trigger: SheetsSyncRunTrigger;
    readonly actorEmail?: string | null;
  }): Promise<SheetsSyncRunRecord>;
  /** Mark a run finished. Only the originating caller finishes its run. */
  finishRun(args: {
    readonly id: string;
    readonly status: Exclude<SheetsSyncRunStatus, 'running'>;
    readonly syncedCount?: number;
    readonly skippedCount?: number;
    /** Already sanitized by the caller — the store never sanitizes. */
    readonly errorMessage?: string | null;
  }): Promise<void>;
  /** Most recent runs, newest first. */
  recent(limit: number): Promise<readonly SheetsSyncRunRecord[]>;
  /** Sum of synced_count over all successful runs (all time). */
  totalSyncedRows(): Promise<number>;
  /**
   * Newest run (any status) with startedAt within the last `withinMin`
   * minutes and still marked 'running' — the in-flight run, if any.
   */
  findInFlight(withinMin: number): Promise<SheetsSyncRunRecord | null>;
}

export interface DrizzleSheetsSyncRunStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

function toRecord(row: typeof sheetsSyncRuns.$inferSelect): SheetsSyncRunRecord {
  return {
    id: row.id,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    trigger: row.trigger as SheetsSyncRunTrigger,
    actorEmail: row.actorEmail,
    status: row.status as SheetsSyncRunStatus,
    syncedCount: row.syncedCount,
    skippedCount: row.skippedCount,
    errorMessage: row.errorMessage,
  };
}

export function createDrizzleSheetsSyncRunStore(
  deps: DrizzleSheetsSyncRunStoreDeps,
): SheetsSyncRunStore {
  const { db } = deps;
  return {
    async startRun(args): Promise<SheetsSyncRunRecord> {
      const rows = await db
        .insert(sheetsSyncRuns)
        .values({
          id: randomUUID(),
          trigger: args.trigger,
          actorEmail: args.actorEmail ?? null,
          status: 'running',
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('sheets_sync_runs insert returned no row');
      return toRecord(row);
    },

    async finishRun(args): Promise<void> {
      await db
        .update(sheetsSyncRuns)
        .set({
          status: args.status,
          finishedAt: new Date(),
          syncedCount: args.syncedCount ?? 0,
          skippedCount: args.skippedCount ?? 0,
          errorMessage: args.errorMessage ?? null,
        })
        .where(eq(sheetsSyncRuns.id, args.id));
    },

    async recent(limit): Promise<readonly SheetsSyncRunRecord[]> {
      const rows = await db
        .select()
        .from(sheetsSyncRuns)
        .orderBy(desc(sheetsSyncRuns.startedAt))
        .limit(limit);
      return rows.map(toRecord);
    },

    async totalSyncedRows(): Promise<number> {
      const rows = await db
        .select({ total: sql<number>`coalesce(sum(${sheetsSyncRuns.syncedCount}), 0)` })
        .from(sheetsSyncRuns)
        .where(eq(sheetsSyncRuns.status, 'success'));
      const total = rows[0]?.total ?? 0;
      return typeof total === 'number' ? total : Number(total);
    },

    async findInFlight(withinMin): Promise<SheetsSyncRunRecord | null> {
      const cutoff = new Date(Date.now() - withinMin * 60_000);
      const rows = await db
        .select()
        .from(sheetsSyncRuns)
        .where(
          and(
            eq(sheetsSyncRuns.status, 'running'),
            gt(sheetsSyncRuns.startedAt, cutoff),
          ),
        )
        .orderBy(desc(sheetsSyncRuns.startedAt))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },
  };
}
