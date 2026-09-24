/**
 * Estimate persistence (BE-3). Insert-only: estimates are immutable records,
 * so the store exposes `save` and `findById` and nothing else — there is no
 * update or delete path by design.
 *
 * The interface is what `EstimateService` depends on; unit tests fake it.
 * The Drizzle implementation below is constructed once in composition.ts.
 */
import { eq } from 'drizzle-orm';
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
}

export interface EstimateStore {
  save(record: EstimateRecord): Promise<void>;
  findById(id: string): Promise<EstimateRecord | null>;
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
      };
    },
  };
}
