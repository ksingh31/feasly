/**
 * Global daily circuit breakers (#750).
 *
 * One counter per scope per UTC day, held in the shared `rate_limit_counters`
 * table (#729), so the ceiling holds across every Functions instance. Used
 * for LLM narrative generations and outbound email. Owner ceilings
 * (2026-11-15) live in config: NARRATIVE_DAILY_LLM_CAP, EMAIL_DAILY_CAP.
 *
 * - `take()` records one unit and says whether it fits today's budget. The
 *   count keeps rising past the cap (refused units are counted too), which
 *   is harmless: the row restarts at 1 on the next UTC day.
 * - `onThreshold` runs exactly once per day: on the take that lands on the
 *   threshold count (concurrent takes get distinct counts from the atomic
 *   upsert). Its errors are swallowed — an alert must never block the work.
 * - Store errors propagate. Callers fail closed (static guide / queue).
 *
 * No PII: the key is the scope name only.
 */
import type { SharedCounterStore } from '../middleware/shared-rate-limit';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DailyCapVerdict {
  /** True when this unit fits within today's cap. */
  readonly allowed: boolean;
  /** Units recorded today, including this one. */
  readonly count: number;
}

export interface DailyCap {
  /** Record one unit against today's budget. Throws on store failure. */
  take(): Promise<DailyCapVerdict>;
  /** Units still available today (never negative). Throws on store failure. */
  remaining(): Promise<number>;
}

export interface DailyCapDeps {
  readonly store: SharedCounterStore;
  /** Counter name, e.g. 'llm' or 'email'. Unique per breaker. */
  readonly scope: string;
  /** Max units per UTC day. 0 refuses everything. */
  readonly limit: number;
  /**
   * Count at which `onThreshold` fires (once per day). Defaults to
   * `limit + 1` — the first refused unit.
   */
  readonly alertAt?: number;
  readonly onThreshold?: (count: number) => Promise<void> | void;
  readonly clock?: () => Date;
}

/** Store key for a scope — fixed per scope; the window rolls daily. */
export function dailyCapKey(scope: string): string {
  return `daily-cap:${scope}`;
}

export function createDailyCap(deps: DailyCapDeps): DailyCap {
  const { store, scope, limit, clock = () => new Date() } = deps;
  const alertAt = deps.alertAt ?? limit + 1;
  const key = dailyCapKey(scope);

  return {
    async take(): Promise<DailyCapVerdict> {
      const now = clock().getTime();
      const windowStartMs = Math.floor(now / DAY_MS) * DAY_MS;
      const count = await store.increment({
        key,
        windowStart: new Date(windowStartMs),
        expiresAt: new Date(windowStartMs + DAY_MS),
      });
      if (count === alertAt && deps.onThreshold) {
        try {
          await deps.onThreshold(count);
        } catch (error) {
          console.warn(
            `daily cap '${scope}': threshold alert failed (${String(error)})`,
          );
        }
      }
      return { allowed: count <= limit, count };
    },

    async remaining(): Promise<number> {
      const used = await store.read(key, clock());
      return Math.max(0, limit - used);
    },
  };
}
