/**
 * Shared refresh-failure policy for the committed community data snapshots
 * (community-aggregates.json, community-mix.json) — issue #469.
 *
 * A production build must never fail solely because data.calgary.ca is
 * unreachable. When a refresh fails:
 *   - snapshot fresh            → continue quietly (info log)
 *   - snapshot stale but valid  → continue with the stale snapshot and surface
 *                                 the staleness as a warning (a GitHub Actions
 *                                 `::warning::` annotation when running in CI)
 *   - snapshot missing/invalid  → fail: there is nothing to build from
 */

export type RefreshFailureOutcome =
  | { readonly action: 'continue'; readonly level: 'info' | 'warning'; readonly message: string }
  | { readonly action: 'fail'; readonly message: string };

export interface RefreshFailureInput {
  /** Script label used as a log prefix, e.g. `build-community-data`. */
  readonly label: string;
  /** Snapshot file name, e.g. `community-aggregates.json`. */
  readonly fileName: string;
  /** Snapshot age in days; null when missing or unparseable. */
  readonly age: number | null;
  readonly maxAgeDays: number;
  readonly error: unknown;
  /** Path of the script, for the manual refresh hint. */
  readonly scriptPath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveRefreshFailure(input: RefreshFailureInput): RefreshFailureOutcome {
  const { label, fileName, age, maxAgeDays, error, scriptPath } = input;
  const reason = errorMessage(error);
  const refreshHint = `tsx ${scriptPath} --force`;
  if (age === null) {
    return {
      action: 'fail',
      message:
        `${label}: FAILED (${reason}) and no readable ${fileName} is available. ` +
        `Re-run the script once network access is available: ${refreshHint}`,
    };
  }
  if (age < maxAgeDays) {
    return {
      action: 'continue',
      level: 'info',
      message: `${label}: refresh failed (${reason}) — continuing with cached ${fileName} from ${age.toFixed(1)} days ago`,
    };
  }
  return {
    action: 'continue',
    level: 'warning',
    message:
      `${label}: refresh failed (${reason}) — continuing with STALE ${fileName} ` +
      `(${age.toFixed(1)} days old, fresh window ${maxAgeDays} days). ` +
      `Refresh and commit the snapshot: ${refreshHint}`,
  };
}

/**
 * Emits the outcome. Warnings become GitHub Actions annotations when
 * `GITHUB_ACTIONS=true` so staleness shows on the workflow run summary.
 * Returns the process exit code (0 continue, 1 fail).
 */
export function reportRefreshFailure(
  outcome: RefreshFailureOutcome,
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'log' | 'warn' | 'error'> = console,
): 0 | 1 {
  if (outcome.action === 'fail') {
    log.error(outcome.message);
    return 1;
  }
  if (outcome.level === 'info') {
    log.warn(outcome.message);
    return 0;
  }
  if (env['GITHUB_ACTIONS'] === 'true') {
    log.log(`::warning title=Stale community data snapshot::${outcome.message}`);
  }
  log.warn(outcome.message);
  return 0;
}
