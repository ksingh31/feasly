/**
 * Admin view of the Postgres-backed job queue (#838).
 *
 * GET /v1/admin/ops/jobs?status=dead — per-status counts plus the most
 * recently updated jobs in one status (default 'dead' = the failed jobs
 * that exhausted their retries). Never carries tokens, emails or names:
 * jobs reference a lead by id only and `lastError` is sanitized.
 */
export type QueueJobStatus = 'pending' | 'running' | 'done' | 'dead' | 'cancelled';

export interface AdminJobSummary {
  readonly id: string;
  /** Handler key, e.g. 'reminder.unfinished-estimate'. */
  readonly type: string;
  readonly status: QueueJobStatus;
  readonly leadId: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** ISO-8601 — next attempt for pending jobs. */
  readonly runAt: string;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface AdminJobsResponse {
  readonly counts: Readonly<Record<QueueJobStatus, number>>;
  /** The status `jobs` is filtered to. */
  readonly status: QueueJobStatus;
  readonly jobs: readonly AdminJobSummary[];
}
