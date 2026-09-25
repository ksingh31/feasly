/**
 * Sheets sync run persistence boundary (story admin/05).
 *
 * The sync worker records one row per run in the append-only
 * `sheets_sync_runs` table. The status endpoint reads the latest rows to
 * compute health. The sync service is the ONLY writer.
 *
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the db directly).
 */
import { count, desc, eq, isNull, sum } from 'drizzle-orm';
import { leads, sheetsSyncRuns } from '../db/schema';

/** How a sync run was triggered. */
export type SheetsSyncTrigger = 'timer' | 'manual';

/** Outcome recorded for a finished run. */
export type SheetsSyncRunStatus = 'success' | 'failed' | 'disabled';

export interface SheetsSyncRunRecord {
  readonly id: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly status: SheetsSyncRunStatus;
  readonly rowsSynced: number;
  readonly rowsSkipped: number;
  /** Sanitized failure summary (no PII, no credentials). Null on success. */
  readonly error: string | null;
  readonly trigger: SheetsSyncTrigger;
}

export interface SheetsSyncRunResult {
  readonly status: SheetsSyncRunStatus;
  readonly rowsSynced: number;
  readonly rowsSkipped: number;
  /** Sanitized failure summary. Undefined on success. */
  readonly error?: string;
}

export interface SheetsSyncRunStore {
  /**
   * Insert a run row with `finished_at = null` (in-flight). Returns the
   * row id so the service can finish it.
   */
  recordRunStart(trigger: SheetsSyncTrigger): Promise<string>;
  /** Mark a run finished with its outcome. */
  recordRunFinish(runId: string, result: SheetsSyncRunResult): Promise<void>;
  /** Latest runs, newest first. */
  getLatestRuns(limit: number): Promise<readonly SheetsSyncRunRecord[]>;
  /** Total rows synced across all successful runs (lifetime counter). */
  getTotalRowsSynced(): Promise<number>;
  /** Leads created but not yet synced to the Sheet. */
  countPendingLeads(): Promise<number>;
}

export interface DrizzleSheetsSyncRunStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

export function createDrizzleSheetsSyncRunStore(
  deps: DrizzleSheetsSyncRunStoreDeps,
): SheetsSyncRunStore {
  const { db } = deps;

  return {
    async recordRunStart(trigger: SheetsSyncTrigger): Promise<string> {
      const [row] = await db
        .insert(sheetsSyncRuns)
        .values({ trigger })
        .returning({ id: sheetsSyncRuns.id });
      return row.id;
    },

    async recordRunFinish(
      runId: string,
      result: SheetsSyncRunResult,
    ): Promise<void> {
      await db
        .update(sheetsSyncRuns)
        .set({
          finishedAt: new Date(),
          status: result.status,
          rowsSynced: result.rowsSynced,
          rowsSkipped: result.rowsSkipped,
          error: result.error ?? null,
        })
        .where(eq(sheetsSyncRuns.id, runId));
    },

    async getLatestRuns(
      limit: number,
    ): Promise<readonly SheetsSyncRunRecord[]> {
      const rows = await db
        .select()
        .from(sheetsSyncRuns)
        .orderBy(desc(sheetsSyncRuns.startedAt))
        .limit(limit);
      return rows.map(toRecord);
    },

    async getTotalRowsSynced(): Promise<number> {
      const [row] = await db
        .select({ total: sum(sheetsSyncRuns.rowsSynced) })
        .from(sheetsSyncRuns)
        .where(eq(sheetsSyncRuns.status, 'success'));
      return Number(row?.total ?? 0);
    },

    async countPendingLeads(): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(leads)
        .where(isNull(leads.sheetsSyncedAt));
      return Number(row?.n ?? 0);
    },
  };
}

function toRecord(row: {
  readonly id: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly status: string;
  readonly rowsSynced: number;
  readonly rowsSkipped: number;
  readonly error: string | null;
  readonly trigger: string;
}): SheetsSyncRunRecord {
  return {
    id: row.id,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    status: row.status as SheetsSyncRunStatus,
    rowsSynced: row.rowsSynced,
    rowsSkipped: row.rowsSkipped,
    error: row.error,
    trigger: row.trigger as SheetsSyncTrigger,
  };
}
