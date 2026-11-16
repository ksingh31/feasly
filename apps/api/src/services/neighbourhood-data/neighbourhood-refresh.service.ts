/**
 * Neighbourhood data refresh job (#773).
 *
 * The only caller of neighbourhood providers. A daily timer tick runs
 * `runDue()`; each provider refreshes once per month (on
 * `refreshDayOfMonth`, UTC) and whenever its configured implementation
 * changes. Admins can force one provider with `refreshNow()`.
 *
 * Guarantees:
 * - Idempotent: a re-run upserts by id and counts only changed rows.
 * - Keeps the previous data on failure: a provider throw (or an empty
 *   snapshot from a real source) writes nothing; the write itself is one
 *   transaction (store.replaceSnapshot).
 * - Resumable: state is saved per provider as it finishes, so a run cut
 *   short resumes with the providers still due on the next daily tick.
 * - One ops alert per failure streak, once a provider has been failing for
 *   `alertAfterFailureDays`; one all-clear when nothing is failing anymore.
 * - Telemetry: one event per provider run (rows changed, outcome, failures)
 *   and one per job run. No PII — only provider names and counts.
 *
 * DB access goes through NeighbourhoodDataStore (never src/db/ directly).
 */
import type {
  NeighbourhoodProvider,
  NeighbourhoodProviderName,
  NeighbourhoodProviders,
} from './providers';
import { NEIGHBOURHOOD_PROVIDER_NAMES, NO_PROVIDER } from './providers';
import type {
  NeighbourhoodDataStore,
  NeighbourhoodRecordMap,
  NeighbourhoodRefreshState,
} from './neighbourhood-data.store';

const DAY_MS = 86_400_000;

export type RefreshTrigger = 'timer' | 'admin';

export interface ProviderRefreshResult {
  readonly provider: NeighbourhoodProviderName;
  readonly implementation: string;
  /** `skipped`: implementation is 'none' (nothing to fetch, nothing written). */
  readonly outcome: 'ok' | 'failed' | 'skipped';
  readonly rowsChanged: number;
  readonly rowsPruned: number;
  readonly rowsTotal: number;
  readonly durationMs: number;
  readonly consecutiveFailures: number;
  /** Error class name on failure (never a message carrying data). */
  readonly error?: string;
}

export interface NeighbourhoodRefreshRunResult {
  readonly trigger: RefreshTrigger;
  /** Providers that ran this tick (not due → not listed). */
  readonly results: readonly ProviderRefreshResult[];
}

/** Telemetry events (App Insights traces via the composition sink). */
export type NeighbourhoodRefreshEvent =
  | ({ readonly event: 'provider_refresh'; readonly trigger: RefreshTrigger } & ProviderRefreshResult)
  | {
      readonly event: 'run';
      readonly trigger: RefreshTrigger;
      readonly ran: number;
      readonly ok: number;
      readonly failed: number;
      readonly skipped: number;
    };

export interface NeighbourhoodRefreshServiceDeps {
  readonly providers: NeighbourhoodProviders;
  readonly store: NeighbourhoodDataStore;
  /** From config: day of the month (UTC) each provider becomes due. */
  readonly refreshDayOfMonth: number;
  /** From config: days of continuous failure before the ops alert. */
  readonly alertAfterFailureDays: number;
  readonly onFailing?: (args: {
    readonly provider: NeighbourhoodProviderName;
    readonly consecutiveFailures: number;
    readonly firstFailureAt: Date;
  }) => Promise<void>;
  readonly onRecovered?: () => Promise<void>;
  readonly onEvent?: (event: NeighbourhoodRefreshEvent) => void;
  readonly clock?: () => Date;
  readonly logWarning?: (message: string) => void;
}

export interface NeighbourhoodRefreshService {
  /** Timer tick: refresh every provider that is due. Never throws per provider. */
  runDue(): Promise<NeighbourhoodRefreshRunResult>;
  /** Admin "refresh now" for one provider, due or not. */
  refreshNow(provider: NeighbourhoodProviderName): Promise<ProviderRefreshResult>;
}

/** A real source returned no rows — treated as a failure (keep old data). */
export class EmptySnapshotError extends Error {
  constructor(provider: string) {
    super(`neighbourhood provider ${provider} returned no rows`);
    this.name = 'EmptySnapshotError';
  }
}

/**
 * Most recent scheduled refresh boundary at or before `now`: 00:00 UTC on
 * `dayOfMonth` of this month, or of last month if that is still ahead.
 */
export function lastScheduledBoundary(now: Date, dayOfMonth: number): Date {
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), dayOfMonth));
  if (thisMonth.getTime() <= now.getTime()) return thisMonth;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, dayOfMonth));
}

/** Due when never succeeded, last success predates the boundary, or the implementation changed. */
export function isProviderDue(
  state: NeighbourhoodRefreshState | null,
  implementation: string,
  now: Date,
  dayOfMonth: number,
): boolean {
  if (!state || !state.lastSuccessAt) return true;
  if (state.implementation !== implementation) return true;
  return state.lastSuccessAt.getTime() < lastScheduledBoundary(now, dayOfMonth).getTime();
}

function providerFor(
  providers: NeighbourhoodProviders,
  name: NeighbourhoodProviderName,
): NeighbourhoodProvider<NeighbourhoodRecordMap[NeighbourhoodProviderName]> {
  switch (name) {
    case 'school-directory':
      return providers.schoolDirectory;
    case 'school-designation':
      return providers.schoolDesignation;
    case 'school-ratings':
      return providers.schoolRatings;
    case 'reviews':
      return providers.reviews;
    case 'amenities':
      return providers.amenities;
    case 'commute':
      return providers.commute;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name || error.constructor.name : 'UnknownError';
}

export function createNeighbourhoodRefreshService(
  deps: NeighbourhoodRefreshServiceDeps,
): NeighbourhoodRefreshService {
  const {
    providers,
    store,
    refreshDayOfMonth,
    alertAfterFailureDays,
    onFailing,
    onRecovered,
    onEvent,
    clock = () => new Date(),
    logWarning = (message: string) => console.warn(message),
  } = deps;

  function emit(event: NeighbourhoodRefreshEvent): void {
    try {
      onEvent?.(event);
    } catch {
      // Telemetry must never fail a refresh.
    }
  }

  async function runProvider(
    name: NeighbourhoodProviderName,
    previous: NeighbourhoodRefreshState | null,
  ): Promise<{ result: ProviderRefreshResult; recovered: boolean }> {
    const provider = providerFor(providers, name);
    const implementation = provider.implementation;
    const startedAt = clock();
    const base = {
      provider: name,
      implementation,
      lastRunAt: startedAt,
    };

    if (implementation === NO_PROVIDER) {
      // No source chosen: nothing fetched, existing rows untouched.
      await store.saveState({
        ...base,
        lastSuccessAt: startedAt,
        lastFailureAt: previous?.lastFailureAt ?? null,
        firstFailureAt: null,
        consecutiveFailures: 0,
        alertedAt: null,
        lastRowsChanged: 0,
        lastError: null,
      });
      const result: ProviderRefreshResult = {
        provider: name,
        implementation,
        outcome: 'skipped',
        rowsChanged: 0,
        rowsPruned: 0,
        rowsTotal: 0,
        durationMs: 0,
        consecutiveFailures: 0,
      };
      return { result, recovered: previous?.alertedAt != null };
    }

    try {
      const records = await provider.fetchAll();
      if (records.length === 0) throw new EmptySnapshotError(name);
      const written = await store.replaceSnapshot(name, implementation, records, startedAt);
      await store.saveState({
        ...base,
        lastSuccessAt: startedAt,
        lastFailureAt: previous?.lastFailureAt ?? null,
        firstFailureAt: null,
        consecutiveFailures: 0,
        alertedAt: null,
        lastRowsChanged: written.rowsChanged,
        lastError: null,
      });
      const result: ProviderRefreshResult = {
        provider: name,
        implementation,
        outcome: 'ok',
        ...written,
        durationMs: clock().getTime() - startedAt.getTime(),
        consecutiveFailures: 0,
      };
      return { result, recovered: previous?.alertedAt != null };
    } catch (error) {
      const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
      const firstFailureAt = previous?.firstFailureAt ?? startedAt;
      let alertedAt = previous?.alertedAt ?? null;
      const failingForMs = startedAt.getTime() - firstFailureAt.getTime();
      if (!alertedAt && failingForMs >= alertAfterFailureDays * DAY_MS && onFailing) {
        try {
          await onFailing({ provider: name, consecutiveFailures, firstFailureAt });
          alertedAt = startedAt;
        } catch (alertError) {
          // Not recorded → the next tick retries the alert.
          logWarning(
            `neighbourhood-refresh: ops alert for ${name} failed (${errorName(alertError)})`,
          );
        }
      }
      await store.saveState({
        ...base,
        lastSuccessAt: previous?.lastSuccessAt ?? null,
        lastFailureAt: startedAt,
        firstFailureAt,
        consecutiveFailures,
        alertedAt,
        lastRowsChanged: 0,
        lastError: errorName(error),
      });
      logWarning(
        `neighbourhood-refresh: ${name} (${implementation}) failed: ${errorName(error)} ` +
          `(consecutive=${consecutiveFailures}); previous data kept`,
      );
      const result: ProviderRefreshResult = {
        provider: name,
        implementation,
        outcome: 'failed',
        rowsChanged: 0,
        rowsPruned: 0,
        rowsTotal: 0,
        durationMs: clock().getTime() - startedAt.getTime(),
        consecutiveFailures,
        error: errorName(error),
      };
      return { result, recovered: false };
    }
  }

  /** All-clear once no provider is still in an alerted failure streak. */
  async function maybeRecover(anyRecovered: boolean): Promise<void> {
    if (!anyRecovered || !onRecovered) return;
    const states = await store.listStates();
    if (states.some((s) => s.alertedAt !== null)) return;
    try {
      await onRecovered();
    } catch (error) {
      logWarning(`neighbourhood-refresh: all-clear failed (${errorName(error)})`);
    }
  }

  async function runOne(
    name: NeighbourhoodProviderName,
    trigger: RefreshTrigger,
    previous: NeighbourhoodRefreshState | null,
  ): Promise<{ result: ProviderRefreshResult; recovered: boolean }> {
    const outcome = await runProvider(name, previous);
    emit({ event: 'provider_refresh', trigger, ...outcome.result });
    return outcome;
  }

  return {
    async runDue(): Promise<NeighbourhoodRefreshRunResult> {
      const results: ProviderRefreshResult[] = [];
      let anyRecovered = false;
      for (const name of NEIGHBOURHOOD_PROVIDER_NAMES) {
        const previous = await store.getState(name);
        const implementation = providerFor(providers, name).implementation;
        if (!isProviderDue(previous, implementation, clock(), refreshDayOfMonth)) continue;
        const { result, recovered } = await runOne(name, 'timer', previous);
        results.push(result);
        anyRecovered ||= recovered;
      }
      await maybeRecover(anyRecovered);
      emit({
        event: 'run',
        trigger: 'timer',
        ran: results.length,
        ok: results.filter((r) => r.outcome === 'ok').length,
        failed: results.filter((r) => r.outcome === 'failed').length,
        skipped: results.filter((r) => r.outcome === 'skipped').length,
      });
      return { trigger: 'timer', results };
    },

    async refreshNow(name): Promise<ProviderRefreshResult> {
      const previous = await store.getState(name);
      const { result, recovered } = await runOne(name, 'admin', previous);
      await maybeRecover(recovered);
      return result;
    },
  };
}
