/**
 * Estimate persistence (BE-3). Insert-only: estimates are immutable records,
 * so the store exposes `save` and `findById` and nothing else — there is no
 * update or delete path by design.
 *
 * The interface is what `EstimateService` depends on; unit tests fake it.
 * The Drizzle implementation below is constructed once in composition.ts.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { estimates } from '../db/schema';

/** The persisted shape — mirrors the contract `EstimateResponse` fields. */
export interface EstimateRecord {
  readonly id: string;
  /** 'new_build' | 'renovation' — which engine branch produced the row. */
  readonly projectType: string;
  readonly addressKey: string;
  readonly inputs: unknown;
  readonly figures: unknown;
  readonly rows: unknown;
  readonly costDataVersion: string;
  readonly createdAt: Date;
  /** consumer/06: validated AI narrative, null until the worker runs. */
  readonly narrative: string | null;
  readonly narrativeGeneratedAt: Date | null;
  /** consumer/06: engine-authored assumptions (renovation only). */
  readonly assumptions: readonly string[] | null;
}

export interface EstimateStore {
  save(record: EstimateRecord): Promise<void>;
  findById(id: string): Promise<EstimateRecord | null>;
  /**
   * consumer/06: set the narrative once. Only updates when the current
   * narrative is null (compare-and-set) — returns true if the write
   * happened, false if a narrative was already present. This keeps the
   * "immutable once set" guarantee without a read-modify-write race.
   */
  setNarrative(args: {
    readonly id: string;
    readonly narrative: string;
    readonly generatedAt: Date;
  }): Promise<boolean>;
}

export interface DrizzleEstimateStoreDeps {
  readonly db: AppDb;
}

export function createDrizzleEstimateStore(
  deps: DrizzleEstimateStoreDeps,
): EstimateStore {
  const { db } = deps;
  return {
    async save(record: EstimateRecord): Promise<void> {
      await db.insert(estimates).values({
        id: record.id,
        projectType: record.projectType,
        addressKey: record.addressKey,
        inputs: record.inputs,
        figures: record.figures,
        rows: record.rows,
        costDataVersion: record.costDataVersion,
        createdAt: record.createdAt,
        narrative: record.narrative,
        narrativeGeneratedAt: record.narrativeGeneratedAt,
        assumptions: record.assumptions,
      });
    },

    async findById(id: string): Promise<EstimateRecord | null> {
      const rows = await db
        .select()
        .from(estimates)
        .where(eq(estimates.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        projectType: row.projectType,
        addressKey: row.addressKey,
        inputs: row.inputs,
        figures: row.figures,
        rows: row.rows,
        costDataVersion: row.costDataVersion,
        createdAt: row.createdAt,
        narrative: row.narrative,
        narrativeGeneratedAt: row.narrativeGeneratedAt,
        assumptions: row.assumptions,
      };
    },

    async setNarrative(args: {
      id: string;
      narrative: string;
      generatedAt: Date;
    }): Promise<boolean> {
      // Compare-and-set in a single statement: only writes when no
      // narrative is present yet, so concurrent workers can't overwrite
      // each other (a second call is a no-op returning false).
      await db
        .update(estimates)
        .set({
          narrative: args.narrative,
          narrativeGeneratedAt: args.generatedAt,
        })
        .where(and(eq(estimates.id, args.id), isNull(estimates.narrative)));
      // Confirm our write won (a racing worker's narrative would differ).
      const row = await db
        .select({ narrative: estimates.narrative })
        .from(estimates)
        .where(eq(estimates.id, args.id))
        .limit(1);
      return row[0]?.narrative === args.narrative;
    },
  };
}
