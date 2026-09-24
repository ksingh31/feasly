/**
 * In-memory fixed-window rate limiter (BE0-003).
 *
 * Config-driven limits, keyed by client IP by the pipeline. Pure logic over
 * an injected clock, so window behavior is unit-testable with fake timers.
 *
 * Scale-out note (deliberate): each Functions instance holds its own
 * counters, so the effective global ceiling is roughly instances ×
 * maxRequests. Acceptable for V1 lead-gen traffic; a distributed (Redis)
 * limiter is the BE-8 hardening path if abuse ever appears.
 */
export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** ms until the current window resets (0 when allowed). */
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string): RateLimitVerdict;
}

export interface RateLimiterDeps {
  readonly windowMs: number;
  readonly maxRequests: number;
  /** Bounds the key map so a flood of distinct keys can't exhaust memory. */
  readonly maxTrackedKeys: number;
  readonly clock?: () => number;
}

interface WindowState {
  count: number;
  windowStart: number;
}

export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  const { windowMs, maxRequests, maxTrackedKeys, clock = () => Date.now() } = deps;
  const windows = new Map<string, WindowState>();

  /** Drop expired windows; only runs when the map overflows the bound. */
  function sweep(now: number): void {
    for (const [key, state] of windows) {
      if (now - state.windowStart >= windowMs) windows.delete(key);
    }
  }

  return {
    check(key: string): RateLimitVerdict {
      const now = clock();
      let state = windows.get(key);
      if (state === undefined || now - state.windowStart >= windowMs) {
        state = { count: 0, windowStart: now };
        windows.set(key, state);
      }
      state.count += 1;

      if (state.count <= maxRequests) {
        return { allowed: true, retryAfterMs: 0 };
      }
      if (windows.size > maxTrackedKeys) sweep(now);
      return {
        allowed: false,
        retryAfterMs: Math.max(0, state.windowStart + windowMs - now),
      };
    },
  };
}
