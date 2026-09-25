/**
 * Community-stats monthly refresh service (neighbourhood/05).
 *
 * Recomputes `community_stats` from fresh City of Calgary Socrata
 * aggregates so the API stays cache-first and never calls Socrata
 * per-request. Shares the canonical aggregation helper with the seed
 * script (`tools/seed-community-stats.ts`) and the SEO pipeline —
 * never duplicated SoQL/SQL.
 *
 * Behavior contract:
 * - Idempotent: rows are upserted on `slug`; run twice → no duplicates.
 * - Communities with fewer than `minAssessmentCount` fresh assessment
 *   records are skipped with a warning log — never zero-filled (thin data
 *   must not masquerade as a cheap community).
 * - One unusable Socrata row never kills the batch; it is counted as
 *   skipped and the rest still refresh.
 * - `alertAfterConsecutiveFailures` timer failures in a row fire
 *   `onRefreshFailing` (wired to the admin/06 `community_stats_failed`
 *   ops alert); the first success afterwards fires `onRefreshRecovered`.
 * - Only a total source outage (Socrata unreachable) counts as a cycle
 *   failure and throws; per-row problems do not.
 *
 * DB access lives in `CommunityStatsService` (and composition.ts) —
 * this service never imports from src/db/ (see test/boundaries.test.ts).
 */
import {
  SocrataAggregateRow,
  buildAggregatesSoql,
  toCommunityStatRecord,
} from './community-stats/socrata-aggregates';
import type { CommunityStatsService } from './community-stats.service';

/**
 * Source of fresh aggregates. Socrata in production; faked in tests.
 * Kept as an interface so the service is unit-testable without network.
 */
export interface CommunityStatsSource {
  /** Latest assessment roll year, e.g. "2025". */
  latestRollYear(): Promise<string>;
  /** Raw SoQL aggregate rows for the roll year (unvalidated JSON). */
  fetchAggregateRows(rollYear: string): Promise<unknown[]>;
}

export interface SocrataCommunityStatsSourceDeps {
  /** From config.propertyData — never hardcoded (boundaries test). */
  readonly socrataBaseUrl: string;
  /** From config.propertyData. */
  readonly datasetId: string;
  /** From config.propertyData. */
  readonly httpTimeoutMs: number;
  readonly userAgent?: string;
}

/**
 * Live Socrata source: `GET {base}/resource/{dataset}.json` with the
 * canonical aggregate SoQL. Transport failures throw (retryable by the
 * service's retry policy); callers treat a throw as a cycle failure.
 */
export function createSocrataCommunityStatsSource(
  deps: SocrataCommunityStatsSourceDeps,
): CommunityStatsSource {
  const {
    socrataBaseUrl,
    datasetId,
    httpTimeoutMs,
    userAgent = 'feasly-community-stats-refresh/1.0',
  } = deps;
  const resourceUrl = `${socrataBaseUrl}/resource/${datasetId}.json`;

  async function fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), httpTimeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': userAgent, Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`Socrata request failed: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as unknown;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Socrata request failed')) {
        throw error;
      }
      throw new Error(
        `Socrata unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async latestRollYear(): Promise<string> {
      const rows = (await fetchJson(
        `${resourceUrl}?$select=roll_year&$order=roll_year DESC&$limit=1`,
      )) as Array<{ roll_year?: string }>;
      const year = rows[0]?.roll_year;
      if (!year) throw new Error('could not determine latest roll_year');
      return year;
    },

    async fetchAggregateRows(rollYear: string): Promise<unknown[]> {
      const rows = await fetchJson(`${resourceUrl}?${buildAggregatesSoql(rollYear)}`);
      if (!Array.isArray(rows)) {
        throw new Error('Socrata aggregate response was not an array');
      }
      return rows as unknown[];
    },
  };
}

export interface CommunityStatsRefreshResult {
  /** Rows (re)written to community_stats. */
  readonly refreshed: number;
  /** Rows not written: unparseable or below the assessment-count threshold. */
  readonly skipped: number;
  /** Assessment roll the aggregates were computed from. */
  readonly rollYear: string;
  /** When this cycle computed the aggregates. */
  readonly refreshedAt: Date;
  /** Consecutive failure count (0 on success). */
  readonly consecutiveFailures: number;
}

export interface CommunityStatsRefreshServiceDeps {
  readonly stats: CommunityStatsService;
  readonly source: CommunityStatsSource;
  /** From config — communities below this are skipped, never zero-filled. */
  readonly minAssessmentCount: number;
  /** From config — failures in a row before the ops alert fires. */
  readonly alertAfterConsecutiveFailures: number;
  /** Called when the failure streak reaches the alert threshold (admin/06). */
  readonly onRefreshFailing?: (args: {
    readonly consecutiveFailures: number;
    /** When the current failure streak started (for the alert's "since when"). */
    readonly firstFailureAt: Date;
  }) => Promise<void>;
  /** Called on the first success after a failing streak (all-clear). */
  readonly onRefreshRecovered?: () => Promise<void>;
  readonly clock?: () => Date;
  /**
   * Retry policy for the Socrata fetch. Defaults to 3 attempts with
   * exponential backoff (1s, 2s, 4s). Override in tests to skip delays.
   */
  readonly retryPolicy?: {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
  };
  /** Sleep function (injectable for tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Warning sink for skipped communities (injectable for tests). */
  readonly logWarning?: (message: string) => void;
}

export interface CommunityStatsRefreshService {
  /**
   * Run one refresh cycle: fetch fresh aggregates, upsert
   * `community_stats`, return counts. Throws only when the source is
   * unreachable (counts as a cycle failure for alerting).
   */
  runRefreshCycle(): Promise<CommunityStatsRefreshResult>;
}

export function createCommunityStatsRefreshService(
  deps: CommunityStatsRefreshServiceDeps,
): CommunityStatsRefreshService {
  const {
    stats,
    source,
    minAssessmentCount,
    alertAfterConsecutiveFailures,
    onRefreshFailing,
    onRefreshRecovered,
    clock = () => new Date(),
    retryPolicy = { maxAttempts: 3, baseDelayMs: 1000 },
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    logWarning = (message: string) => console.warn(message),
  } = deps;

  let consecutiveFailures = 0;
  let wasFailing = false;
  /** Start of the current failure streak (null when healthy). */
  let firstFailureAt: Date | null = null;

  /** Fetch roll year + aggregates with exponential-backoff retry. */
  async function fetchWithRetry(): Promise<{ rollYear: string; rows: unknown[] }> {
    const { maxAttempts, baseDelayMs } = retryPolicy;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const rollYear = await source.latestRollYear();
        const rows = await source.fetchAggregateRows(rollYear);
        return { rollYear, rows };
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await sleep(baseDelayMs * 2 ** (attempt - 1));
        }
      }
    }
    throw lastError;
  }

  return {
    async runRefreshCycle(): Promise<CommunityStatsRefreshResult> {
      try {
        const { rollYear, rows } = await fetchWithRetry();
        const refreshedAt = clock();

        const records = [];
        let skipped = 0;
        for (const raw of rows) {
          const parsed = SocrataAggregateRow.safeParse(raw);
          if (!parsed.success) {
            skipped++;
            continue;
          }
          let record;
          try {
            record = toCommunityStatRecord(parsed.data, refreshedAt);
          } catch {
            skipped++;
            continue;
          }
          if (record.assessmentCount < minAssessmentCount) {
            // Thin data: skip loudly, never write a zero-filled row.
            skipped++;
            logWarning(
              `community-stats-refresh: skipping ${record.name} ` +
                `(${record.assessmentCount} assessments < ${minAssessmentCount})`,
            );
            continue;
          }
          records.push(record);
        }

        const refreshed = await stats.upsertMany(records);

        // Success resets the failure streak.
        if (consecutiveFailures > 0 || wasFailing) {
          consecutiveFailures = 0;
          firstFailureAt = null;
          if (wasFailing) {
            wasFailing = false;
            await onRefreshRecovered?.();
          }
        }

        return {
          refreshed,
          skipped,
          rollYear,
          refreshedAt,
          consecutiveFailures: 0,
        };
      } catch (error) {
        if (consecutiveFailures === 0) {
          firstFailureAt = clock();
        }
        consecutiveFailures++;
        if (consecutiveFailures >= alertAfterConsecutiveFailures && !wasFailing) {
          wasFailing = true;
          await onRefreshFailing?.({
            consecutiveFailures,
            firstFailureAt: firstFailureAt ?? clock(),
          });
        }
        throw error;
      }
    },
  };
}
