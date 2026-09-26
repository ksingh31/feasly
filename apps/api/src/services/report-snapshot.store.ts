/**
 * Report-snapshot persistence (phase-2 wiring).
 *
 * Snapshots are immutable per version — reads and appends only, no updates
 * and no deletes (a shared link must re-render exactly the same numbers
 * forever). The interface is what `ReportService` depends on; unit tests
 * fake it. The Drizzle implementation is constructed once in
 * composition.ts.
 */
import { desc, eq } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { reportSnapshots } from '../db/schema';

export interface ReportSnapshotRecord {
  readonly id: string;
  readonly estimateId: string;
  readonly leadId: string;
  readonly inputs: unknown;
  readonly buildRange: unknown;
  readonly totalRange: unknown;
  readonly landValue: unknown;
  readonly rows: unknown;
  readonly narrative: string;
  readonly assumptions: readonly string[] | null;
  readonly projectType: string;
  readonly renoInputs: unknown;
  readonly version: number;
  readonly preparedAt: Date;
  readonly updatedAt: Date | null;
  readonly createdAt: Date;
}

export interface NewReportSnapshot {
  readonly id: string;
  readonly estimateId: string;
  readonly leadId: string;
  readonly inputs: unknown;
  readonly buildRange: unknown;
  readonly totalRange: unknown;
  readonly landValue: unknown;
  readonly rows: unknown;
  readonly narrative: string;
  readonly assumptions: readonly string[] | null;
  readonly projectType: string;
  readonly renoInputs: unknown;
  readonly version: number;
  readonly updatedAt?: Date | null;
}

export interface ReportSnapshotStore {
  /** Latest snapshot for an estimate, or null when none exists yet. */
  findLatestByEstimateId(estimateId: string): Promise<ReportSnapshotRecord | null>;
  /** Append a new immutable version. Rejects on version conflict. */
  insert(snapshot: NewReportSnapshot): Promise<ReportSnapshotRecord>;
}

type SnapshotRow = typeof reportSnapshots.$inferSelect;

function toRecord(row: SnapshotRow): ReportSnapshotRecord {
  return {
    id: row.id,
    estimateId: row.estimateId,
    leadId: row.leadId,
    inputs: row.inputs,
    buildRange: row.buildRange,
    totalRange: row.totalRange,
    landValue: row.landValue,
    rows: row.rows,
    narrative: row.narrative,
    assumptions: row.assumptions,
    projectType: row.projectType,
    renoInputs: row.renoInputs,
    version: row.version,
    preparedAt: row.preparedAt,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

export interface DrizzleReportSnapshotStoreDeps {
  readonly db: AppDb;
}

export function createDrizzleReportSnapshotStore(
  deps: DrizzleReportSnapshotStoreDeps,
): ReportSnapshotStore {
  const { db } = deps;
  return {
    async findLatestByEstimateId(
      estimateId: string,
    ): Promise<ReportSnapshotRecord | null> {
      const rows = await db
        .select()
        .from(reportSnapshots)
        .where(eq(reportSnapshots.estimateId, estimateId))
        .orderBy(desc(reportSnapshots.version))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async insert(snapshot: NewReportSnapshot): Promise<ReportSnapshotRecord> {
      const rows = await db
        .insert(reportSnapshots)
        .values({
          id: snapshot.id,
          estimateId: snapshot.estimateId,
          leadId: snapshot.leadId,
          inputs: snapshot.inputs,
          buildRange: snapshot.buildRange,
          totalRange: snapshot.totalRange,
          landValue: snapshot.landValue,
          rows: snapshot.rows,
          narrative: snapshot.narrative,
          assumptions: snapshot.assumptions,
          projectType: snapshot.projectType,
          renoInputs: snapshot.renoInputs,
          version: snapshot.version,
          updatedAt: snapshot.updatedAt ?? null,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('report snapshot insert returned no row');
      return toRecord(row);
    },
  };
}
