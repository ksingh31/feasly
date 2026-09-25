/**
 * Narrative generation log persistence (consumer/06).
 *
 * The per-estimate daily cost guard ("5 narrative generations per estimate
 * per day") counts rows in `narrative_generations` inside the trailing
 * window — one row per LLM provider call, append-only, no counters to race
 * and no updates. The interface is what `NarrativeService` depends on;
 * unit tests fake it. The Drizzle implementation is constructed once in
 * composition.ts.
 */
import { and, eq, gte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AppDb } from '../db/client';
import { narrativeGenerations } from '../db/schema';

export interface NarrativeGenerationStore {
  /** LLM provider calls for this estimate at or after `since`. */
  countSince(estimateId: string, since: Date): Promise<number>;
  /** Record one LLM provider call. */
  record(estimateId: string, at: Date): Promise<void>;
}

export interface DrizzleNarrativeGenerationStoreDeps {
  readonly db: AppDb;
}

export function createDrizzleNarrativeGenerationStore(
  deps: DrizzleNarrativeGenerationStoreDeps,
): NarrativeGenerationStore {
  const { db } = deps;
  return {
    async countSince(estimateId: string, since: Date): Promise<number> {
      const rows = await db
        .select({ id: narrativeGenerations.id })
        .from(narrativeGenerations)
        .where(
          and(
            eq(narrativeGenerations.estimateId, estimateId),
            gte(narrativeGenerations.generatedAt, since),
          ),
        );
      return rows.length;
    },

    async record(estimateId: string, at: Date): Promise<void> {
      await db.insert(narrativeGenerations).values({
        id: randomUUID(),
        estimateId,
        generatedAt: at,
      });
    },
  };
}
