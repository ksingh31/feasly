/**
 * Postgres-backed job queue (#838).
 *
 * Producers `enqueue` typed jobs (idempotent on a dedupe key); the
 * job-queue timer calls `runOnce`, which claims due jobs
 * (`FOR UPDATE SKIP LOCKED` in the store) and dispatches each to the
 * handler registered for its type.
 *
 * Outcome per job:
 *   - handler resolves → 'done' (a handler that legitimately decides not
 *     to act — consent withdrawn, already sent — resolves too);
 *   - handler throws a retryable error → back to 'pending' with exponential
 *     backoff: base · 2^(attempt-1) seconds, capped at the max;
 *   - throws on its last attempt, throws a `PermanentJobError`, or has no
 *     handler → 'dead' (dead-letter; visible in the admin jobs view).
 *
 * A job whose worker crashed mid-run stays 'running'; once its lock is
 * older than the lock timeout the next run reclaims it (that reclaim
 * counts as an attempt, so a poison job still dead-letters).
 *
 * The clock is injected so retry and dead-letter timing is tested with a
 * fixed clock. Errors are sanitized before they are stored or reported —
 * never tokens, emails or keys.
 */
import type { AdminJobsResponse, QueueJobStatus } from '@feasly/contracts';
import { sanitizeErrorMessage } from '../lib/sanitize-error';
import type { JobQueueStore, JobRecord } from './job-queue.store';

/** A handler failure that must not be retried (goes straight to dead). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export type JobHandler = (job: JobRecord) => Promise<void>;

export interface EnqueueJobInput {
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly leadId?: string | null;
  readonly dedupeKey?: string | null;
  /** Defaults to now. */
  readonly runAt?: Date;
}

export interface JobQueueRunResult {
  readonly claimed: number;
  readonly done: number;
  readonly retried: number;
  readonly deadLettered: number;
}

export interface JobQueue {
  /** Enqueue a job. `enqueued` false = a job with the dedupe key exists. */
  enqueue(input: EnqueueJobInput): Promise<{ readonly enqueued: boolean }>;
  /** Cancel a lead's pending jobs (e.g. on unsubscribe). */
  cancelForLead(leadId: string, types?: readonly string[]): Promise<number>;
}

export interface JobQueueService extends JobQueue {
  /** Claim and process one batch of due jobs. */
  runOnce(): Promise<JobQueueRunResult>;
  /** Admin view: per-status counts + the latest jobs in `status`. */
  listJobs(args?: { readonly status?: QueueJobStatus; readonly limit?: number }): Promise<AdminJobsResponse>;
}

export interface JobQueueServiceDeps {
  readonly store: JobQueueStore;
  /**
   * Handlers by job type. A getter so handlers can be bound after the
   * queue is built (producers and consumers reference each other).
   */
  readonly handlers: () => Readonly<Record<string, JobHandler>>;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly backoffBaseSeconds: number;
  readonly backoffMaxSeconds: number;
  readonly lockTimeoutSeconds: number;
  /** Sanitized sink for per-job failures (visibility; never PII). */
  readonly onJobError?: (message: string) => void;
  readonly clock?: () => Date;
}

/** Max stored error length (the column is text; keep rows small). */
const MAX_ERROR_LENGTH = 500;
/** Admin list hard cap. */
const MAX_LIST_LIMIT = 200;

/**
 * Backoff before the NEXT attempt, after `attempts` failed attempts:
 * base · 2^(attempts-1), capped. Pure — exported for tests.
 */
export function backoffSeconds(
  attempts: number,
  baseSeconds: number,
  maxSeconds: number,
): number {
  const exponent = Math.max(0, attempts - 1);
  // 2^30 already dwarfs any sane cap; avoid Infinity on silly inputs.
  const raw = baseSeconds * 2 ** Math.min(exponent, 30);
  return Math.min(raw, maxSeconds);
}

export function createJobQueueService(deps: JobQueueServiceDeps): JobQueueService {
  const clock = deps.clock ?? (() => new Date());
  const onJobError = deps.onJobError ?? ((message: string) => console.error(message));

  function errorText(error: unknown): string {
    return sanitizeErrorMessage(error).slice(0, MAX_ERROR_LENGTH);
  }

  async function processJob(job: JobRecord): Promise<'done' | 'retried' | 'dead'> {
    const handler = deps.handlers()[job.type];
    if (!handler) {
      const message = `no handler registered for job type '${job.type}'`;
      await deps.store.deadLetter({ id: job.id, now: clock(), error: message });
      onJobError(`job-queue: dead-lettered (type=${job.type} reason=no-handler)`);
      return 'dead';
    }
    try {
      await handler(job);
    } catch (error) {
      const message = errorText(error);
      const now = clock();
      const exhausted = job.attempts >= job.maxAttempts;
      if (exhausted || error instanceof PermanentJobError) {
        await deps.store.deadLetter({ id: job.id, now, error: message });
        onJobError(
          `job-queue: dead-lettered (type=${job.type} attempts=${job.attempts} error=${message})`,
        );
        return 'dead';
      }
      const delay = backoffSeconds(
        job.attempts,
        deps.backoffBaseSeconds,
        deps.backoffMaxSeconds,
      );
      await deps.store.reschedule({
        id: job.id,
        now,
        runAt: new Date(now.getTime() + delay * 1000),
        error: message,
      });
      onJobError(
        `job-queue: attempt failed, retrying in ${delay}s (type=${job.type} attempts=${job.attempts} error=${message})`,
      );
      return 'retried';
    }
    await deps.store.complete({ id: job.id, now: clock() });
    return 'done';
  }

  return {
    async enqueue(input) {
      const now = clock();
      const result = await deps.store.enqueue({
        type: input.type,
        payload: input.payload ?? {},
        leadId: input.leadId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        runAt: input.runAt ?? now,
        maxAttempts: deps.maxAttempts,
        now,
      });
      return { enqueued: result.enqueued };
    },

    cancelForLead(leadId, types) {
      return deps.store.cancelPendingForLead({
        leadId,
        now: clock(),
        ...(types ? { types } : {}),
      });
    },

    async runOnce() {
      const now = clock();
      const claimed = await deps.store.claimDue({
        now,
        staleBefore: new Date(now.getTime() - deps.lockTimeoutSeconds * 1000),
        limit: deps.batchSize,
      });
      let done = 0;
      let retried = 0;
      let deadLettered = 0;
      for (const job of claimed) {
        let outcome: 'done' | 'retried' | 'dead';
        try {
          outcome = await processJob(job);
        } catch (error) {
          // The bookkeeping write itself failed (DB blip). The job stays
          // 'running' and is reclaimed after the lock timeout; one bad row
          // never kills the batch.
          onJobError(`job-queue: bookkeeping failed (type=${job.type} error=${errorText(error)})`);
          continue;
        }
        if (outcome === 'done') done++;
        else if (outcome === 'retried') retried++;
        else deadLettered++;
      }
      return { claimed: claimed.length, done, retried, deadLettered };
    },

    async listJobs(args) {
      const status = args?.status ?? 'dead';
      const limit = Math.min(Math.max(1, args?.limit ?? 50), MAX_LIST_LIMIT);
      const [counts, rows] = await Promise.all([
        deps.store.countByStatus(),
        deps.store.listByStatus({ status, limit }),
      ]);
      return {
        counts,
        status,
        jobs: rows.map((job) => ({
          id: job.id,
          type: job.type,
          status: job.status,
          leadId: job.leadId,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          runAt: job.runAt.toISOString(),
          lastError: job.lastError,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
          completedAt: job.completedAt?.toISOString() ?? null,
        })),
      };
    },
  };
}
