/**
 * Cross-instance rate limiting (#729).
 *
 * The in-memory limiter in `./rate-limit` keeps counters per Functions
 * instance, so with scale-out the effective ceiling is instances × max. The
 * money/mail endpoints (lead capture, estimates, magic-link resend) instead
 * count in a shared store — Postgres, the database we already run (no new
 * resource; a paid Redis is explicitly out of scope).
 *
 * - Fixed windows are aligned to the epoch (`floor(now / windowMs)`), so
 *   every instance agrees on which window a request lands in.
 * - Keys are SHA-256 hashed with the limiter scope before they reach the
 *   store: raw client IPs and email addresses are PII and never persisted.
 * - Store failure never turns into an outage: the limiter falls back to its
 *   per-instance in-memory limiter (the pre-#729 guarantee) and reports the
 *   error through `onStoreError`.
 *
 * Middleware never imports `db/` — the store is an injected interface; the
 * Drizzle implementation lives in `services/rate-limit.store.ts`.
 */
import { createHash } from 'node:crypto';
import type { RateLimiter, RateLimitVerdict } from './rate-limit';

/** Persistence for shared counters. One row per hashed key. */
export interface SharedCounterStore {
  /**
   * Atomically record one hit for `key` in the window starting at
   * `windowStart` and return the window's hit count after this hit. A row
   * left over from an older window restarts at 1.
   */
  increment(args: {
    readonly key: string;
    readonly windowStart: Date;
    readonly expiresAt: Date;
  }): Promise<number>;
  /** Hit count of `key`'s window if it has not expired at `now`, else 0. */
  read(key: string, now: Date): Promise<number>;
  /** Overwrite `key` with a single hit active until `expiresAt`. */
  set(args: {
    readonly key: string;
    readonly windowStart: Date;
    readonly expiresAt: Date;
  }): Promise<void>;
  /** Delete rows that expired before `now`; returns how many were removed. */
  deleteExpired(now: Date): Promise<number>;
}

/** A limiter whose verdict needs I/O. The pipeline accepts either kind. */
export interface AsyncRateLimiter {
  check(key: string): Promise<RateLimitVerdict>;
}

export type AnyRateLimiter = RateLimiter | AsyncRateLimiter;

/** Store key: `<scope>:<sha256(scope + key)>` — no raw IP/email persisted. */
export function sharedCounterKey(scope: string, key: string): string {
  const digest = createHash('sha256').update(`${scope}\u0000${key}`, 'utf8').digest('hex');
  return `${scope}:${digest}`;
}

/**
 * Throttles expired-row cleanup to once per `intervalMs` per instance. The
 * cleanup runs inline (awaited, errors swallowed) so no promise or timer is
 * left dangling after the request.
 */
function createSweeper(
  store: SharedCounterStore,
  intervalMs: number,
): (now: number) => Promise<void> {
  let lastSweep = Number.NEGATIVE_INFINITY;
  return async (now: number) => {
    if (now - lastSweep < intervalMs) return;
    lastSweep = now;
    try {
      await store.deleteExpired(new Date(now));
    } catch {
      // Best effort: a missed sweep only leaves a few stale rows behind.
    }
  };
}

export interface SharedRateLimiterDeps {
  readonly store: SharedCounterStore;
  /** Namespaces the keys, e.g. 'lead:ip'. Must be unique per limiter. */
  readonly scope: string;
  readonly windowMs: number;
  readonly maxRequests: number;
  /** Used when the store errors — the per-instance pre-#729 behavior. */
  readonly fallback: RateLimiter;
  /** Expired-row cleanup cadence per instance. */
  readonly sweepIntervalMs: number;
  readonly onStoreError?: (error: unknown) => void;
  readonly clock?: () => number;
}

export function createSharedRateLimiter(deps: SharedRateLimiterDeps): AsyncRateLimiter {
  const {
    store,
    scope,
    windowMs,
    maxRequests,
    fallback,
    sweepIntervalMs,
    onStoreError = (error) =>
      console.warn(`shared rate limiter '${scope}' fell back to in-memory: ${String(error)}`),
    clock = () => Date.now(),
  } = deps;
  const sweep = createSweeper(store, sweepIntervalMs);

  return {
    async check(key: string): Promise<RateLimitVerdict> {
      const now = clock();
      const windowStartMs = Math.floor(now / windowMs) * windowMs;
      const windowEndMs = windowStartMs + windowMs;
      let count: number;
      try {
        await sweep(now);
        count = await store.increment({
          key: sharedCounterKey(scope, key),
          windowStart: new Date(windowStartMs),
          expiresAt: new Date(windowEndMs),
        });
      } catch (error) {
        onStoreError(error);
        return fallback.check(key);
      }
      if (count <= maxRequests) return { allowed: true, retryAfterMs: 0 };
      return { allowed: false, retryAfterMs: Math.max(0, windowEndMs - now) };
    },
  };
}

/**
 * Cross-instance cooldown: "at most one X per key per `cooldownMs`", where
 * the cooldown starts only when the caller says so (e.g. after a delivered
 * email — a failed send leaves the window open for an immediate retry).
 */
export interface SharedCooldown {
  isActive(key: string): Promise<boolean>;
  start(key: string): Promise<void>;
}

export interface SharedCooldownDeps {
  readonly store: SharedCounterStore;
  readonly scope: string;
  readonly cooldownMs: number;
  readonly onStoreError?: (error: unknown) => void;
  readonly clock?: () => number;
}

/** Per-instance cooldown — the fallback, and the default when no store is wired. */
export function createInMemoryCooldown(
  cooldownMs: number,
  clock: () => number = () => Date.now(),
): SharedCooldown {
  const startedAt = new Map<string, number>();
  return {
    async isActive(key) {
      const at = startedAt.get(key);
      return at !== undefined && clock() - at < cooldownMs;
    },
    async start(key) {
      const now = clock();
      // Bounded: drop elapsed entries before adding (keys are per-email).
      for (const [k, at] of startedAt) {
        if (now - at >= cooldownMs) startedAt.delete(k);
      }
      startedAt.set(key, now);
    },
  };
}

export function createSharedCooldown(deps: SharedCooldownDeps): SharedCooldown {
  const {
    store,
    scope,
    cooldownMs,
    onStoreError = (error) =>
      console.warn(`shared cooldown '${scope}' fell back to in-memory: ${String(error)}`),
    clock = () => Date.now(),
  } = deps;
  const fallback = createInMemoryCooldown(cooldownMs, clock);

  return {
    async isActive(key) {
      try {
        const hits = await store.read(sharedCounterKey(scope, key), new Date(clock()));
        if (hits > 0) return true;
      } catch (error) {
        onStoreError(error);
      }
      // Also honor a cooldown recorded locally while the store was down.
      return fallback.isActive(key);
    },
    async start(key) {
      await fallback.start(key);
      const now = clock();
      try {
        await store.set({
          key: sharedCounterKey(scope, key),
          windowStart: new Date(now),
          expiresAt: new Date(now + cooldownMs),
        });
      } catch (error) {
        onStoreError(error);
      }
    },
  };
}
