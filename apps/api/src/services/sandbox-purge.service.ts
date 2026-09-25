/**
 * Sandbox purge service (api-mcp/09).
 *
 * Daily timer hard-deletes sandbox test rows older than the retention
 * window (default 30 days) across `leads`, `estimates`, `magic_links`,
 * and `analytics_events`. Only rows with `sandbox = true` are touched —
 * production rows are never deleted by this job.
 *
 * Deletion order respects foreign keys:
 * 1. `magic_links` (lead_id SET NULL on lead delete — purge sandbox links directly)
 * 2. `analytics_events` (no FKs)
 * 3. `leads` (cascades to lead_notes + lead_status_history)
 * 4. `estimates` (leads reference estimates — delete leads first)
 *
 * The first run executes in dry-run mode (config flag): counts are
 * computed and logged, but nothing is deleted. This gives Karan a chance
 * to verify the blast radius before the job goes live.
 *
 * Purged counts are returned per table; the timer adapter logs them to
 * the ops channel (admin/06 reuses this when it lands).
 */
export interface PurgeCounts {
  readonly magicLinks: number;
  readonly analyticsEvents: number;
  readonly leads: number;
  readonly estimates: number;
}

export interface PurgeResult {
  readonly counts: PurgeCounts;
  /** True when dry-run mode was active (nothing deleted). */
  readonly dryRun: boolean;
  /** The cutoff timestamp used (rows created before this were eligible). */
  readonly cutoff: Date;
}

export interface SandboxPurgeStore {
  /**
   * Hard-delete sandbox rows created before `cutoff`.
   * Returns the number of rows deleted per table.
   * Must respect FK order (magic_links, analytics_events, leads, estimates).
   */
  purgeOldSandboxRows(cutoff: Date): Promise<PurgeCounts>;
  /**
   * Count sandbox rows created before `cutoff` without deleting.
   * Used for dry-run mode.
   */
  countOldSandboxRows(cutoff: Date): Promise<PurgeCounts>;
}

export interface SandboxPurgeServiceDeps {
  readonly store: SandboxPurgeStore;
  /** Days after creation before a sandbox row is eligible for purge. Default 30. */
  readonly retentionDays?: number;
  /** When true, counts are computed but nothing is deleted. Default true (first-run safety). */
  readonly dryRun?: boolean;
  readonly clock?: () => Date;
}

export interface SandboxPurgeService {
  /**
   * Run one purge cycle. Returns per-table counts, whether dry-run was
   * active, and the cutoff timestamp used.
   */
  runPurge(): Promise<PurgeResult>;
}

export function createSandboxPurgeService(
  deps: SandboxPurgeServiceDeps,
): SandboxPurgeService {
  const {
    store,
    retentionDays = 30,
    dryRun = true,
    clock = () => new Date(),
  } = deps;

  return {
    async runPurge(): Promise<PurgeResult> {
      const now = clock();
      const cutoff = new Date(now.getTime() - retentionDays * 24 * 3_600_000);

      const counts = dryRun
        ? await store.countOldSandboxRows(cutoff)
        : await store.purgeOldSandboxRows(cutoff);

      return { counts, dryRun, cutoff };
    },
  };
}

/**
 * Format the purge result as a single log line for the ops channel.
 * Per-table counts are always present; the dry-run flag is explicit so
 * the first run is unambiguous in the logs.
 */
export function formatPurgeLogLine(result: PurgeResult): string {
  const { counts, dryRun } = result;
  const mode = dryRun ? 'dry-run' : 'live';
  return (
    `sandbox-purge: cycle complete (mode=${mode} ` +
    `magic_links=${counts.magicLinks} ` +
    `analytics_events=${counts.analyticsEvents} ` +
    `leads=${counts.leads} ` +
    `estimates=${counts.estimates})`
  );
}
