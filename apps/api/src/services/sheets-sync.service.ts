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
 * metric. The consecutive-failure counter and the `lagging` flag live in
 * the persistent `sheets_sync_state` table (not in memory) so a Function
 * App restart or scale-out can't reset the streak or hide a lagging sync.
 * Recovery (a successful cycle) clears both and fires the all-clear hook.
 */
import type { LeadStore } from './lead.store';
import type { EstimateStore } from './estimate.store';
import type { SheetsSyncStateStore } from './sheets-sync-state.store';
import type { SheetLeadRow, SheetsClient } from './sheets/sheets-client';
import type { SheetsSyncRunStore } from './sheets-sync-run.store';
import { sanitizeErrorMessage } from '../lib/sanitize-error';

export interface SheetsSyncServiceDeps {
  readonly leads: LeadStore;
  readonly estimates: EstimateStore;
  readonly sheets: SheetsClient;
  /** Persistent worker health (lagging metric, failure streak). */
  readonly syncState: SheetsSyncStateStore;
  /**
   * Durable run history (admin/05). Every cycle records one row in
   * `sheets_sync_runs` so the ops panel survives Function App restarts.
   */
  readonly runs: SheetsSyncRunStore;
  /** From config — empty = sync disabled (fail closed). */
  readonly enabled: boolean;
  /** Max leads per run (backpressure). */
  readonly maxLeadsPerRun: number;
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
  /** The `sheets_sync.lagging` metric (AC4). */
  readonly lagging: boolean;
}

export interface SheetsSyncService {
  /**
   * Run one sync cycle. Returns counts. Never throws for per-lead
   * failures (one bad lead doesn't kill the batch); throws only when
   * the Sheets API itself is unreachable (counts as a cycle failure).
   *
   * Every cycle records one row in `sheets_sync_runs` (admin/05) — the
   * durable run history the ops panel reads.
   */
  runSyncCycle(args?: {
    /** 'timer' for the hourly run (default), 'manual' for admin "Sync now". */
    readonly trigger?: 'timer' | 'manual';
    /** Admin email for manual runs (recorded on the run row + audit). */
    readonly actorEmail?: string | null;
  }): Promise<SheetsSyncResult>;
}

/** Failures before the worker is considered lagging (AC4). */
export const SHEETS_SYNC_LAG_AFTER_FAILURES = 3;

export function createSheetsSyncService(
  deps: SheetsSyncServiceDeps,
): SheetsSyncService {
  const {
    leads,
    estimates,
    sheets,
    syncState,
    runs,
    enabled,
    maxLeadsPerRun,
    onSyncLagging,
    onSyncRecovered,
    clock = () => new Date(),
    retryPolicy = { maxAttempts: 3, baseDelayMs: 1000 },
    sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;

  return {
    async runSyncCycle(args): Promise<SheetsSyncResult> {
      const run = await runs.startRun({
        trigger: args?.trigger ?? 'timer',
        actorEmail: args?.actorEmail ?? null,
      });

      if (!enabled) {
        await runs.finishRun({ id: run.id, status: 'disabled' });
        return {
          synced: 0,
          skipped: 0,
          disabled: true,
          consecutiveFailures: 0,
          lagging: false,
        };
      }

      const state = await syncState.get();
      const now = clock();

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
          const stampedAt = clock();
          for (const row of rows) {
            await leads.setSheetsSyncedAt({ id: row.leadId, at: stampedAt });
          }
          synced = rows.length;
        }

        // Success: refresh the watermark stats and clear any lag.
        const wasLagging = state.lagging;
        await syncState.update({
          lastRunAt: now,
          lastSuccessAt: now,
          consecutiveFailures: 0,
          firstFailureAt: null,
          rowsSyncedTotal: state.rowsSyncedTotal + synced,
          lagging: false,
        });
        if (wasLagging) {
          await onSyncRecovered?.();
        }

        await runs.finishRun({
          id: run.id,
          status: 'success',
          syncedCount: synced,
          skippedCount: skipped,
        });

        return {
          synced,
          skipped,
          disabled: false,
          consecutiveFailures: 0,
          lagging: false,
        };
      } catch (error) {
        const consecutiveFailures = state.consecutiveFailures + 1;
        const firstFailureAt =
          state.consecutiveFailures === 0 ? now : (state.firstFailureAt ?? now);
        const lagging =
          consecutiveFailures >= SHEETS_SYNC_LAG_AFTER_FAILURES;
        await syncState.update({
          lastRunAt: now,
          consecutiveFailures,
          firstFailureAt,
          lagging,
        });
        await runs.finishRun({
          id: run.id,
          status: 'failed',
          // Sanitized: no credentials, no PII in the run history.
          errorMessage: sanitizeErrorMessage(error),
        });
        if (lagging && !state.lagging) {
          // Transition into lagging — fire the alert exactly once per
          // streak (the ops-alerts service dedupes repeat emails anyway).
          await onSyncLagging?.({ consecutiveFailures, firstFailureAt });
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
