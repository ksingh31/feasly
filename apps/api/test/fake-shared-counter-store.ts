/**
 * In-memory SharedCounterStore for unit tests (#729). Mirrors the SQL
 * semantics of `services/rate-limit.store.ts`: a hit for a newer window
 * restarts the count; an older or equal window keeps counting.
 */
import type { SharedCounterStore } from '../src/middleware/shared-rate-limit';

interface Row {
  windowStart: number;
  count: number;
  expiresAt: number;
}

export interface FakeSharedCounterStore extends SharedCounterStore {
  readonly rows: Map<string, Row>;
  /** Make every call reject (simulates a database outage). */
  failing: boolean;
}

export function createFakeSharedCounterStore(): FakeSharedCounterStore {
  const rows = new Map<string, Row>();
  const store: FakeSharedCounterStore = {
    rows,
    failing: false,
    async increment({ key, windowStart, expiresAt }) {
      if (store.failing) throw new Error('store down');
      const ws = windowStart.getTime();
      const row = rows.get(key);
      if (!row) {
        rows.set(key, { windowStart: ws, count: 1, expiresAt: expiresAt.getTime() });
        return 1;
      }
      row.count = row.windowStart >= ws ? row.count + 1 : 1;
      row.windowStart = Math.max(row.windowStart, ws);
      row.expiresAt = Math.max(row.expiresAt, expiresAt.getTime());
      return row.count;
    },
    async read(key, now) {
      if (store.failing) throw new Error('store down');
      const row = rows.get(key);
      return row && row.expiresAt > now.getTime() ? row.count : 0;
    },
    async set({ key, windowStart, expiresAt }) {
      if (store.failing) throw new Error('store down');
      rows.set(key, {
        windowStart: windowStart.getTime(),
        count: 1,
        expiresAt: expiresAt.getTime(),
      });
    },
    async deleteExpired(now) {
      if (store.failing) throw new Error('store down');
      let removed = 0;
      for (const [key, row] of rows) {
        if (row.expiresAt < now.getTime()) {
          rows.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
  return store;
}
