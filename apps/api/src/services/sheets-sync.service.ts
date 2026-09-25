/**
 * Google Sheets auto-sync worker service (admin/04).
 *
 * Hourly timer syncs leads to Karan's Google Sheet. Postgres is the source
 * of truth — the worker never writes to `leads` except the `sheets_synced_at`
 * watermark. On any conflict, Postgres wins (the Sheet is a read-only mirror).
 *
 * Fail-closed: if the Sheet ID or service-account email is unconfigured,
 * the worker does nothing and reports the misconfiguration (the alert
 * wires into admin/06 when it lands; for now the failure is logged and
 * surfaced via the returned result).
 *
 * Failure handling: 3 consecutive failures → alert + `sheets_sync.lagging`
 * metric. The consecutive-failure counter resets on success.
 */
import type { LeadStore } from './lead.store';
import type { EstimateStore } from './estimate.store';
import type { SheetLeadRow, SheetsClient } from './sheets/sheets-client';
import type {
  SheetsSyncRunStore,
  SheetsSyncTrigger,
} from './sheets-sync-run.store';

/** Re-exported for consumers that only depend on this module (e.g. tests). */
export type { SheetsSyncTrigger } from './sheets-sync-run.store';

export interface SheetsSyncServiceDeps {
  readonly leads: LeadStore;
  readonly estimates: EstimateStore;
  readonly sheets: SheetsClient;
  /** From config — empty = sync disabled (fail closed). */
  readonly enabled: boolean;
  /** Max leads per run (backpressure). */
  readonly maxLeadsPerRun: number;
  /**
   * admin/05: run-history writer. Optional so existing tests keep working;
   * production wiring always provides it.
   */
  readonly runs?: SheetsSyncRunStore;
  /** Called on 3 consecutive failures (wires to admin/06 ops alerts). */
  readonly onSyncLagging?: (args: {
    readonly consecutiveFailures: number;
    /** When the current failure streak started (for the alert's "since when"). */
    readonly firstFailureAt: Date;
  }) => Promise<void>;
  /** Called when the lag clears after a successful sync. */
  readonly onSyncRecovered?: () => Promise<void>;
  readonly clock?: () => Date;
  /**
   * Retry policy for the Sheets API call. Defaults to 3 attempts with
   * exponential backoff (1s, 2s, 4s). Override in tests to skip delays.
   */
  readonly retryPolicy?: {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
  };
  /** Sleep function (injectable for tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SheetsSyncResult {
  readonly synced: number;
  readonly skipped: number;
  /** True when the worker ran but Sheets is not configured. */
  readonly disabled: boolean;
  /** Consecutive failure count (0 on success). */
  readonly consecutiveFailures: number;
}

export interface SheetsSyncService {
  /**
   * Run one sync cycle. Returns counts. Never throws for per-lead
   * failures (one bad lead doesn't kill the batch); throws only when
   * the Sheets API itself is unreachable (counts as a cycle failure).
   *
   * admin/05: `trigger` records how the run was started ('timer' default,
   * 'manual' from the admin "Sync now" button). Each run is recorded in
   * the `sheets_sync_runs` table when a run store is wired.
   */
  runSyncCycle(trigger?: SheetsSyncTrigger): Promise<SheetsSyncResult>;
}

export function createSheetsSyncService(
  deps: SheetsSyncServiceDeps,
): SheetsSyncService {
  const {
    leads,
    estimates,
    sheets,
    enabled,
    maxLeadsPerRun,
    runs,
    onSyncLagging,
    onSyncRecovered,
    clock = () => new Date(),
    retryPolicy = { maxAttempts: 3, baseDelayMs: 1000 },
    sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;

  let consecutiveFailures = 0;
  let wasLagging = false;
  /** Start of the current failure streak (null when healthy). */
  let firstFailureAt: Date | null = null;

  return {
    async runSyncCycle(
      trigger: SheetsSyncTrigger = 'timer',
    ): Promise<SheetsSyncResult> {
      if (!enabled) {
        const result = {
          synced: 0,
          skipped: 0,
          disabled: true,
          consecutiveFailures: 0,
        };
        // admin/05: record the disabled run so the status page shows
        // "disabled" instead of a confusing empty history.
        if (runs) {
          const runId = await runs.recordRunStart(trigger);
          await runs.recordRunFinish(runId, {
            status: 'disabled',
            rowsSynced: 0,
            rowsSkipped: 0,
          });
        }
        return result;
      }

      // admin/05: open the run row before doing any work so a crash
      // mid-cycle still leaves an in-flight marker.
      const runId = runs ? await runs.recordRunStart(trigger) : null;

      try {
        const candidates = await leads.findSheetsSyncCandidates({
          limit: maxLeadsPerRun,
        });

        let synced = 0;
        let skipped = 0;
        const rows: SheetLeadRow[] = [];

        for (const lead of candidates) {
          try {
            const row = await buildSheetRow(lead.id);
            if (row) {
              rows.push(row);
            } else {
              skipped++;
            }
          } catch {
            // One bad lead must not kill the batch; it stays unsynced and
            // will be retried on the next hourly run.
            skipped++;
          }
        }

        if (rows.length > 0) {
          await upsertWithRetry(rows);
          const now = clock();
          for (const row of rows) {
            await leads.setSheetsSyncedAt({ id: row.leadId, at: now });
          }
          synced = rows.length;
        }

        // Success resets the failure counter.
        if (consecutiveFailures > 0 || wasLagging) {
          consecutiveFailures = 0;
          firstFailureAt = null;
          if (wasLagging) {
            wasLagging = false;
            await onSyncRecovered?.();
          }
        }

        // admin/05: close the run row.
        if (runs && runId) {
          await runs.recordRunFinish(runId, {
            status: 'success',
            rowsSynced: synced,
            rowsSkipped: skipped,
          });
        }

        return {
          synced,
          skipped,
          disabled: false,
          consecutiveFailures: 0,
        };
      } catch (error) {
        if (consecutiveFailures === 0) {
          firstFailureAt = clock();
        }
        consecutiveFailures++;
        // admin/05: record the failed run with a sanitized error summary
        // (no PII, no credentials — just the error class + message).
        if (runs && runId) {
          await runs.recordRunFinish(runId, {
            status: 'failed',
            rowsSynced: 0,
            rowsSkipped: 0,
            error: sanitizeError(error),
          });
        }
        if (consecutiveFailures >= 3 && !wasLagging) {
          wasLagging = true;
          await onSyncLagging?.({
            consecutiveFailures,
            firstFailureAt: firstFailureAt ?? clock(),
          });
        }
        throw error;
      }
    },
  };

  /**
   * Upsert rows with exponential backoff retry. The story requires retry
   * with backoff — transient Sheets API failures (rate limits, 5xx) should
   * not immediately count as a cycle failure.
   */
  async function upsertWithRetry(rows: SheetLeadRow[]): Promise<void> {
    const { maxAttempts, baseDelayMs } = retryPolicy;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await sheets.upsertRows(rows);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          const delayMs = baseDelayMs * 2 ** (attempt - 1);
          await sleep(delayMs);
        }
      }
    }
    throw lastError;
  }

  async function buildSheetRow(
    leadId: string,
  ): Promise<SheetLeadRow | null> {
    const lead = await leads.findById(leadId);
    if (!lead) return null;

    // Join to the estimate for project_type, sqft, tier, ranges.
    // The estimate's inputs/figures are JSONB — extract defensively.
    const estimate = await estimates.findById(lead.estimateId);
    const inputs = (estimate?.inputs ?? {}) as Record<string, unknown>;
    const figures = (estimate?.figures ?? {}) as Record<string, unknown>;

    const sqft =
      typeof inputs.sqft === 'number'
        ? inputs.sqft
        : typeof inputs.renoSqft === 'number'
          ? inputs.renoSqft
          : null;
    const tier = typeof inputs.tier === 'string' ? inputs.tier : '';
    // Figures: { build, total, land } — use the total range.
    const total = (figures.total ?? {}) as Record<string, unknown>;
    const rangeLow = typeof total.low === 'number' ? total.low : null;
    const rangeHigh = typeof total.high === 'number' ? total.high : null;

    return {
      leadId: lead.id,
      name: lead.name,
      email: lead.email,
      phone: lead.phone ?? '',
      timeline: lead.timeline,
      leadScore: lead.leadScore,
      status: lead.status,
      projectType: estimate?.projectType ?? '',
      address: lead.addressKey,
      sqft,
      tier,
      rangeLow,
      rangeHigh,
      consentTs: lead.consentTs.toISOString(),
      marketingConsent: lead.marketingConsent,
      tenant: lead.tenantKey ?? '',
      source: lead.source,
      createdAt: lead.createdAt.toISOString(),
    };
  }
}

/**
 * admin/05: sanitize an error for the run-history table. The run history
 * is admin-visible, so we keep only the error class + message — never
 * stack traces (may contain paths), and never the raw error object (may
 * carry request/response bodies with PII or credentials).
 */
function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || 'Error';
    // Truncate — some API errors embed long payloads in the message.
    const message = error.message.slice(0, 500);
    return `${name}: ${message}`;
  }
  return `Error: ${String(error).slice(0, 500)}`;
}
