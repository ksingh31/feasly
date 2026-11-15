/**
 * Cross-instance rate limiting (#729).
 *
 * Unit tests run the limiter over the in-memory fake store; the integration
 * block runs two independent limiter "instances" (as two Functions hosts
 * would build them) over ONE PGlite database with the real migrations, and
 * asserts the lead and magic-link limits hold at the configured value — not
 * double (AC2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/middleware/rate-limit';
import {
  createSharedCooldown,
  createSharedRateLimiter,
  sharedCounterKey,
  type SharedCounterStore,
} from '../src/middleware/shared-rate-limit';
import { createDrizzleRateLimitStore } from '../src/services/rate-limit.store';
import { createFakeSharedCounterStore } from './fake-shared-counter-store';
import { createTestDb, type TestDb } from './pglite-db';

const WINDOW_MS = 60_000;

/** One Functions instance's view: its own fallback, the shared store. */
function instance(
  store: SharedCounterStore,
  scope: string,
  maxRequests: number,
  clock: () => number,
  errors: unknown[] = [],
) {
  return createSharedRateLimiter({
    store,
    scope,
    windowMs: WINDOW_MS,
    maxRequests,
    sweepIntervalMs: 300_000,
    fallback: createRateLimiter({ windowMs: WINDOW_MS, maxRequests, maxTrackedKeys: 100, clock }),
    onStoreError: (error) => errors.push(error),
    clock,
  });
}

async function allowedCount(
  limiters: ReadonlyArray<{ check(key: string): Promise<{ allowed: boolean }> }>,
  key: string,
  attempts: number,
): Promise<number> {
  let allowed = 0;
  for (let i = 0; i < attempts; i += 1) {
    const limiter = limiters[i % limiters.length]!;
    if ((await limiter.check(key)).allowed) allowed += 1;
  }
  return allowed;
}

describe('createSharedRateLimiter (unit)', () => {
  it('allows up to maxRequests per aligned window, then denies with retryAfterMs', async () => {
    const store = createFakeSharedCounterStore();
    let now = 5 * WINDOW_MS + 10_000;
    const limiter = instance(store, 'lead:ip', 3, () => now);
    for (let i = 0; i < 3; i += 1) expect((await limiter.check('1.2.3.4')).allowed).toBe(true);
    const denied = await limiter.check('1.2.3.4');
    expect(denied.allowed).toBe(false);
    // Window is epoch-aligned: [5W, 6W) — 50s left at 5W+10s.
    expect(denied.retryAfterMs).toBe(50_000);
    now = 6 * WINDOW_MS;
    expect((await limiter.check('1.2.3.4')).allowed).toBe(true);
  });

  it('two instances share one budget (not instances × max)', async () => {
    const store = createFakeSharedCounterStore();
    const clock = () => 1_000;
    const a = instance(store, 'lead:ip', 10, clock);
    const b = instance(store, 'lead:ip', 10, clock);
    expect(await allowedCount([a, b], '1.2.3.4', 30)).toBe(10);
  });

  it('never persists the raw key (IPs and emails are PII)', async () => {
    const store = createFakeSharedCounterStore();
    const limiter = instance(store, 'magic-link:send', 5, () => 0);
    await limiter.check('owner@example.com');
    const keys = [...store.rows.keys()];
    expect(keys).toEqual([sharedCounterKey('magic-link:send', 'owner@example.com')]);
    expect(keys[0]).not.toContain('owner@example.com');
    expect(keys[0]).toMatch(/^magic-link:send:[0-9a-f]{64}$/);
  });

  it('scopes keys so two limiters never share a counter', () => {
    expect(sharedCounterKey('lead:ip', '1.2.3.4')).not.toBe(
      sharedCounterKey('estimate:ip', '1.2.3.4'),
    );
  });

  it('falls back to the in-memory limiter when the store fails (still limits)', async () => {
    const store = createFakeSharedCounterStore();
    store.failing = true;
    const errors: unknown[] = [];
    const limiter = instance(store, 'lead:ip', 2, () => 0, errors);
    expect(await allowedCount([limiter], '1.2.3.4', 5)).toBe(2);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('sweeps expired rows at most once per interval', async () => {
    const store = createFakeSharedCounterStore();
    let now = 0;
    const limiter = instance(store, 'lead:ip', 5, () => now);
    await limiter.check('old');
    now = 400_000; // > sweep interval and the old window has expired
    await limiter.check('new');
    expect([...store.rows.keys()]).toEqual([sharedCounterKey('lead:ip', 'new')]);
  });
});

describe('createSharedCooldown (unit)', () => {
  it('is inactive until started, active for cooldownMs, then clears', async () => {
    const store = createFakeSharedCounterStore();
    let now = 0;
    const cooldown = createSharedCooldown({ store, scope: 'magic-link:cooldown', cooldownMs: 60_000, clock: () => now });
    expect(await cooldown.isActive('a@example.com')).toBe(false);
    await cooldown.start('a@example.com');
    now = 59_999;
    expect(await cooldown.isActive('a@example.com')).toBe(true);
    expect(await cooldown.isActive('b@example.com')).toBe(false);
    now = 60_000;
    expect(await cooldown.isActive('a@example.com')).toBe(false);
  });

  it('keeps a local cooldown when the store is down', async () => {
    const store = createFakeSharedCounterStore();
    store.failing = true;
    const errors: unknown[] = [];
    const cooldown = createSharedCooldown({
      store,
      scope: 'magic-link:cooldown',
      cooldownMs: 60_000,
      clock: () => 0,
      onStoreError: (e) => errors.push(e),
    });
    await cooldown.start('a@example.com');
    expect(await cooldown.isActive('a@example.com')).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('shared limits across two instances (PGlite integration, AC2)', () => {
  let testDb: TestDb;
  let store: SharedCounterStore;

  beforeAll(async () => {
    testDb = await createTestDb();
    store = createDrizzleRateLimitStore({ db: testDb.db });
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('lead limit (10/min per IP) holds at 10 across two instances, not 20', async () => {
    const errors: unknown[] = [];
    const clock = () => 7 * WINDOW_MS + 1;
    const a = instance(store, 'lead:ip', 10, clock, errors);
    const b = instance(store, 'lead:ip', 10, clock, errors);
    expect(await allowedCount([a, b], '198.51.100.1', 30)).toBe(10);
    expect(errors).toEqual([]);
  });

  it('holds under concurrent hits from both instances', async () => {
    const clock = () => 8 * WINDOW_MS + 1;
    const a = instance(store, 'lead:ip', 10, clock);
    const b = instance(store, 'lead:ip', 10, clock);
    const verdicts = await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? a : b).check('198.51.100.2')),
    );
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(10);
  });

  it('restarts the count in the next window', async () => {
    let now = 9 * WINDOW_MS + 1;
    const a = instance(store, 'lead:ip', 2, () => now);
    expect(await allowedCount([a], '198.51.100.3', 3)).toBe(2);
    now = 10 * WINDOW_MS + 1;
    expect((await a.check('198.51.100.3')).allowed).toBe(true);
  });

  it('magic-link send budget holds across two instances', async () => {
    const clock = () => 11 * WINDOW_MS + 1;
    const a = instance(store, 'magic-link:send', 5, clock);
    const b = instance(store, 'magic-link:send', 5, clock);
    expect(await allowedCount([a, b], 'owner@example.com', 12)).toBe(5);
  });

  it('magic-link cooldown started on one instance blocks the other', async () => {
    let now = 12 * WINDOW_MS;
    const make = () =>
      createSharedCooldown({ store, scope: 'magic-link:cooldown', cooldownMs: 60_000, clock: () => now });
    const a = make();
    const b = make();
    expect(await b.isActive('owner@example.com')).toBe(false);
    await a.start('owner@example.com');
    expect(await b.isActive('owner@example.com')).toBe(true);
    now += 60_001;
    expect(await b.isActive('owner@example.com')).toBe(false);
  });

  it('deleteExpired removes only dead rows', async () => {
    const now = new Date(20 * WINDOW_MS);
    await store.set({ key: 'test:dead', windowStart: new Date(0), expiresAt: new Date(1) });
    await store.set({
      key: 'test:live',
      windowStart: now,
      expiresAt: new Date(now.getTime() + WINDOW_MS),
    });
    await store.deleteExpired(now);
    expect(await store.read('test:dead', new Date(0))).toBe(0);
    expect(await store.read('test:live', now)).toBe(1);
  });
});
