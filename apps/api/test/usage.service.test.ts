/**
 * Usage service unit tests (api-mcp/07).
 *
 * The store is faked at the interface boundary (per the skill: fake the
 * service's deps, not Drizzle internals). Time is mocked via the clock
 * dep for sliding-window tests.
 */
import { describe, expect, it } from 'vitest';
import {
  createUsageService,
  type UsageAggregate,
  type UsageQuery,
  type UsageStore,
} from '../src/services/usage.service';

/** In-memory UsageStore fake with injectable clock. */
function createFakeStore() {
  const rows: {
    id: string;
    apiKeyId: string;
    endpoint: string;
    estimateId: string | null;
    createdAt: Date;
  }[] = [];
  let now = new Date('2026-09-25T00:00:00Z');

  const store: UsageStore = {
    async insert(record) {
      rows.push({ ...record });
    },
    async countSince(apiKeyId: string, since: Date) {
      return rows.filter(
        (r) => r.apiKeyId === apiKeyId && r.createdAt > since,
      ).length;
    },
    async oldestSince(apiKeyId: string, since: Date) {
      const matching = rows
        .filter((r) => r.apiKeyId === apiKeyId && r.createdAt > since)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return matching[0]?.createdAt ?? null;
    },
    async aggregate(query: UsageQuery): Promise<UsageAggregate[]> {
      // Minimal fake: group by day+endpoint for the filtered rows.
      const filtered = rows.filter((r) => {
        if (query.apiKeyId && r.apiKeyId !== query.apiKeyId) return false;
        if (query.from && r.createdAt < query.from) return false;
        if (query.to && r.createdAt > query.to) return false;
        return true;
      });
      const groups = new Map<string, { date: string; endpoint: string; count: number; estimatesCreated: number }>();
      for (const r of filtered) {
        const date = r.createdAt.toISOString().slice(0, 10);
        const key = `${date}|${r.endpoint}`;
        const g = groups.get(key) ?? {
          date,
          endpoint: r.endpoint,
          count: 0,
          estimatesCreated: 0,
        };
        g.count += 1;
        if (r.estimateId) g.estimatesCreated += 1;
        groups.set(key, g);
      }
      return [...groups.values()];
    },
  };

  return {
    store,
    rows,
    setNow: (d: Date) => {
      now = d;
    },
    getNow: () => now,
  };
}

describe('usage service (api-mcp/07)', () => {
  it('AC1: with rate_limit=5, the 6th request in 60s is denied', async () => {
    const fake = createFakeStore();
    const usage = createUsageService({
      store: fake.store,
      clock: fake.getNow,
    });
    const keyId = 'key-1';

    // 5 allowed
    for (let i = 0; i < 5; i++) {
      const v = await usage.checkRateLimit(keyId, 5);
      expect(v.allowed).toBe(true);
      await usage.recordUsage({ apiKeyId: keyId, endpoint: '/api/v1/estimate' });
    }
    // 6th denied
    const denied = await usage.checkRateLimit(keyId, 5);
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe(5);
    expect(denied.remaining).toBe(0);
    // Reset epoch is within the current window (now..now+60s)
    const nowEpoch = Math.floor(fake.getNow().getTime() / 1000);
    expect(denied.resetEpoch).toBeGreaterThanOrEqual(nowEpoch);
    expect(denied.resetEpoch).toBeLessThanOrEqual(nowEpoch + 60);
  });

  it('AC2: window slides — requests older than 60s stop counting', async () => {
    const fake = createFakeStore();
    const usage = createUsageService({
      store: fake.store,
      clock: fake.getNow,
    });
    const keyId = 'key-1';
    const t0 = new Date('2026-09-25T00:00:00Z');

    // Fill the window at t0
    for (let i = 0; i < 5; i++) {
      await usage.recordUsage({ apiKeyId: keyId, endpoint: '/api/v1/estimate' });
    }
    expect((await usage.checkRateLimit(keyId, 5)).allowed).toBe(false);

    // Move past the window — all 5 slide out
    fake.setNow(new Date(t0.getTime() + 61_000));
    const v = await usage.checkRateLimit(keyId, 5);
    expect(v.allowed).toBe(true);
    expect(v.remaining).toBe(4); // 5 - 0 - 1 (this request)
  });

  it('AC3: limits are per key, not per IP (two keys independent)', async () => {
    const fake = createFakeStore();
    const usage = createUsageService({
      store: fake.store,
      clock: fake.getNow,
    });

    // Exhaust key-A
    for (let i = 0; i < 5; i++) {
      await usage.recordUsage({ apiKeyId: 'key-a', endpoint: '/api/v1/estimate' });
    }
    expect((await usage.checkRateLimit('key-a', 5)).allowed).toBe(false);
    // key-B unaffected
    expect((await usage.checkRateLimit('key-b', 5)).allowed).toBe(true);
  });

  it('AC5: usage aggregates reconcile with recorded rows', async () => {
    const fake = createFakeStore();
    const usage = createUsageService({
      store: fake.store,
      clock: fake.getNow,
    });

    await usage.recordUsage({
      apiKeyId: 'key-1',
      endpoint: '/api/v1/estimate',
      estimateId: 'est-1',
    });
    await usage.recordUsage({
      apiKeyId: 'key-1',
      endpoint: '/api/v1/estimate',
    });
    await usage.recordUsage({
      apiKeyId: 'key-1',
      endpoint: '/api/v1/properties/lookup',
    });

    const agg = await usage.getUsage({}, { kind: 'admin' });
    const est = agg.find((a) => a.endpoint === '/api/v1/estimate');
    const lookup = agg.find((a) => a.endpoint === '/api/v1/properties/lookup');
    expect(est?.count).toBe(2);
    expect(est?.estimatesCreated).toBe(1);
    expect(lookup?.count).toBe(1);
    expect(lookup?.estimatesCreated).toBe(0);
  });

  it('owner scope: querying another key → 403', async () => {
    const fake = createFakeStore();
    const usage = createUsageService({
      store: fake.store,
      clock: fake.getNow,
    });
    await expect(
      usage.getUsage(
        { apiKeyId: 'key-other' },
        { kind: 'owner', apiKeyId: 'key-1' },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('owner scope: own key allowed, key_id param ignored when matching', async () => {
    const fake = createFakeStore();
    const usage = createUsageService({
      store: fake.store,
      clock: fake.getNow,
    });
    await usage.recordUsage({ apiKeyId: 'key-1', endpoint: '/api/v1/estimate' });
    const agg = await usage.getUsage(
      {},
      { kind: 'owner', apiKeyId: 'key-1' },
    );
    expect(agg.length).toBe(1);
  });
});
