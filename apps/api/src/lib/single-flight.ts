/**
 * Single-flight (#756): concurrent callers asking for the same key share one
 * in-flight promise, so N simultaneous lookups for an uncached address cause
 * one upstream call. The entry is removed once the promise settles — results
 * are cached elsewhere; failures are never memoized.
 */
export interface SingleFlight<T> {
  /**
   * Runs `fn` for `key` unless a call for `key` is already in flight, in
   * which case the caller joins it. `joined` tells the caller which happened.
   */
  run(key: string, fn: () => Promise<T>): { readonly promise: Promise<T>; readonly joined: boolean };
  /** Number of keys currently in flight (tests/diagnostics). */
  size(): number;
}

export function createSingleFlight<T>(): SingleFlight<T> {
  const inflight = new Map<string, Promise<T>>();
  return {
    run(key, fn) {
      const existing = inflight.get(key);
      if (existing) return { promise: existing, joined: true };
      const promise = (async () => {
        try {
          return await fn();
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, promise);
      return { promise, joined: false };
    },
    size: () => inflight.size,
  };
}
