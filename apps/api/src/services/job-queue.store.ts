/**
 * Postgres-backed job queue persistence (#838).
 *
 * The `jobs` table is the queue — no new Azure resource. Workers claim due
 * rows with `SELECT … FOR UPDATE SKIP LOCKED` inside a single UPDATE, so
 * two concurrent timer instances never claim the same job. A row claimed
 * but never finished (worker crash) is reclaimed once its lock is older
 * than the lock timeout.
 *
 * Every timestamp comes from the caller's clock (the service), so the
 * queue's retry/backoff behaviour is testable with a fixed clock.
 *
 * PII discipline: `payload` and `last_error` never carry tokens, emails or
 * names — callers pass ids only and errors are sanitized by the service.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { jobs } from '../db/schema';

export type JobStatus = 'pending' | 'running' | 'done' | 'dead' | 'cancelled';

export interface JobRecord {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly leadId: string | null;
  readonly dedupeKey: string | null;
  readonly status: JobStatus;
  /** Attempts made so far, INCLUDING the current one once claimed. */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAt: Date;
  readonly lockedAt: Date | null;
  readonly lastError: string | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewJob {
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly leadId?: string | null;
  /** Unique key — a second enqueue with the same key is a no-op. */
  readonly dedupeKey?: string | null;
  readonly runAt: Date;
  readonly maxAttempts: number;
  readonly now: Date;
}

export interface JobQueueStore {
  /**
   * Insert a pending job. Idempotent on `dedupeKey`: when a job with the
   * same key already exists (any status) nothing is inserted and
   * `enqueued` is false.
   */
  enqueue(job: NewJob): Promise<{ readonly enqueued: boolean; readonly id: string | null }>;
  /**
   * Atomically claim up to `limit` due jobs: pending with run_at ≤ now, or
   * running with a lock older than `staleBefore`. Claimed rows become
   * 'running', get locked_at = now and attempts + 1. Uses
   * FOR UPDATE SKIP LOCKED — concurrent claimers get disjoint sets.
   */
  claimDue(args: {
    readonly now: Date;
    readonly staleBefore: Date;
    readonly limit: number;
  }): Promise<readonly JobRecord[]>;
  /** Mark a claimed job done. */
  complete(args: { readonly id: string; readonly now: Date }): Promise<void>;
  /** Put a failed job back to pending, due at `runAt`. */
  reschedule(args: {
    readonly id: string;
    readonly now: Date;
    readonly runAt: Date;
    readonly error: string;
  }): Promise<void>;
  /** Dead-letter a job (no further attempts). */
  deadLetter(args: { readonly id: string; readonly now: Date; readonly error: string }): Promise<void>;
  /**
   * Cancel a lead's PENDING jobs (optionally only the given types). Running
   * jobs are left alone — their handler re-checks consent before sending.
   * Returns how many were cancelled.
   */
  cancelPendingForLead(args: {
    readonly leadId: string;
    readonly now: Date;
    readonly types?: readonly string[];
  }): Promise<number>;
  /** Jobs in one status, most recently updated first (admin view). */
  listByStatus(args: { readonly status: JobStatus; readonly limit: number }): Promise<readonly JobRecord[]>;
  /** Row counts per status (admin summary). */
  countByStatus(): Promise<Readonly<Record<JobStatus, number>>>;
}

type JobRow = typeof jobs.$inferSelect;

const STATUSES: readonly JobStatus[] = ['pending', 'running', 'done', 'dead', 'cancelled'];

function toStatus(value: string): JobStatus {
  return (STATUSES as readonly string[]).includes(value) ? (value as JobStatus) : 'dead';
}

function toRecord(row: JobRow): JobRecord {
  const payload =
    row.payload !== null && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    type: row.type,
    payload,
    leadId: row.leadId,
    dedupeKey: row.dedupeKey,
    status: toStatus(row.status),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAt: row.runAt,
    lockedAt: row.lockedAt,
    lastError: row.lastError,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createDrizzleJobQueueStore(deps: { readonly db: AppDb }): JobQueueStore {
  const { db } = deps;
  return {
    async enqueue(job) {
      const rows = await db
        .insert(jobs)
        .values({
          id: randomUUID(),
          type: job.type,
          payload: job.payload ?? {},
          leadId: job.leadId ?? null,
          dedupeKey: job.dedupeKey ?? null,
          status: 'pending',
          attempts: 0,
          maxAttempts: job.maxAttempts,
          runAt: job.runAt,
          createdAt: job.now,
          updatedAt: job.now,
        })
        .onConflictDoNothing({ target: jobs.dedupeKey })
        .returning({ id: jobs.id });
      const id = rows[0]?.id ?? null;
      return { enqueued: id !== null, id };
    },

    async claimDue(args) {
      const due = db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          or(
            and(eq(jobs.status, 'pending'), lte(jobs.runAt, args.now)),
            and(eq(jobs.status, 'running'), lt(jobs.lockedAt, args.staleBefore)),
          ),
        )
        .orderBy(asc(jobs.runAt))
        .limit(args.limit)
        .for('update', { skipLocked: true });
      const rows = await db
        .update(jobs)
        .set({
          status: 'running',
          lockedAt: args.now,
          attempts: sql`${jobs.attempts} + 1`,
          updatedAt: args.now,
        })
        .where(inArray(jobs.id, due))
        .returning();
      return rows.map(toRecord).sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
    },

    async complete(args) {
      await db
        .update(jobs)
        .set({
          status: 'done',
          lockedAt: null,
          completedAt: args.now,
          updatedAt: args.now,
        })
        .where(eq(jobs.id, args.id));
    },

    async reschedule(args) {
      await db
        .update(jobs)
        .set({
          status: 'pending',
          lockedAt: null,
          runAt: args.runAt,
          lastError: args.error,
          updatedAt: args.now,
        })
        .where(eq(jobs.id, args.id));
    },

    async deadLetter(args) {
      await db
        .update(jobs)
        .set({
          status: 'dead',
          lockedAt: null,
          lastError: args.error,
          completedAt: args.now,
          updatedAt: args.now,
        })
        .where(eq(jobs.id, args.id));
    },

    async cancelPendingForLead(args) {
      const conditions = [eq(jobs.leadId, args.leadId), eq(jobs.status, 'pending')];
      if (args.types && args.types.length > 0) {
        conditions.push(inArray(jobs.type, [...args.types]));
      }
      const rows = await db
        .update(jobs)
        .set({ status: 'cancelled', completedAt: args.now, updatedAt: args.now })
        .where(and(...conditions))
        .returning({ id: jobs.id });
      return rows.length;
    },

    async listByStatus(args) {
      const rows = await db
        .select()
        .from(jobs)
        .where(eq(jobs.status, args.status))
        .orderBy(desc(jobs.updatedAt))
        .limit(args.limit);
      return rows.map(toRecord);
    },

    async countByStatus() {
      const rows = await db
        .select({ status: jobs.status, n: sql<number>`count(*)::int` })
        .from(jobs)
        .groupBy(jobs.status);
      const counts: Record<JobStatus, number> = {
        pending: 0,
        running: 0,
        done: 0,
        dead: 0,
        cancelled: 0,
      };
      for (const row of rows) {
        counts[toStatus(row.status)] += Number(row.n);
      }
      return counts;
    },
  };
}
