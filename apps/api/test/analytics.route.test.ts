/**
 * Analytics route + pipeline tests (story consumer/01).
 *
 * Covers: route delegation to the service interface, end-to-end ingest
 * through the dedicated analytics pipeline (PGlite-backed store, real SQL),
 * RFC 7807 400s with CONSENT_REQUIRED for missing/future consent_ts, the
 * allowlist 400 for arbitrary event names, and the dedicated 300/min
 * per-IP rate limiter (429 with RATE_LIMITED once the window budget is
 * spent).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createComposition, type AppComposition } from '../src/composition';
import { createAnalyticsRoute } from '../src/routes/analytics.route';
import { createAnalyticsService } from '../src/services/analytics.service';
import { createDrizzleAnalyticsStore } from '../src/services/analytics.store';
import { isProblemDetails } from '../src/middleware/errors';
import { createTestDb, type TestDb } from './pglite-db';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@localhost:5432/feasly_test',
  // Tight budget so the rate-limit test doesn't need hundreds of requests.
  ANALYTICS_RATE_LIMIT_MAX_REQUESTS: '2',
} as NodeJS.ProcessEnv;

describe('analytics route', () => {
  it('delegates to the service interface', async () => {
    const store = { insert: async () => { throw new Error('unused'); } };
    const service = createAnalyticsService({ store });
    const route = createAnalyticsRoute({ analytics: service });
    // Missing consent_ts → the service's CONSENT_REQUIRED 400, proving
    // delegation (no store touch).
    const error = await route
      .handle({ event: 'step_view', route: '/', ts: '2026-09-25T12:00:00.000Z' })
      .catch((e) => e);
    expect(error.status).toBe(400);
    expect(error.code).toBe('CONSENT_REQUIRED');
  });
});

describe('events through the analytics pipeline (PGlite-backed store)', () => {
  let testDb: TestDb;
  let app: AppComposition;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createComposition(TEST_ENV, {
      analyticsStore: createDrizzleAnalyticsStore({ db: testDb.db }),
    });
  }, 60_000);
  afterAll(async () => {
    await app.db.close();
    await testDb.close();
  });

  // Wall-clock-relative timestamps: the pipeline uses the real composition
  // clock, so fixed dates would turn into future-dated consent_ts (a
  // time-bomb — the 11:59Z fixture became "future" after 11:59Z passed).
  const validBody = () => {
    const now = new Date();
    return {
      event: 'step_view',
      route: '/estimate/scope',
      ts: now.toISOString(),
      consent_ts: new Date(now.getTime() - 60_000).toISOString(),
    };
  };

  it('ingests an event end to end', async () => {
    const outcome = await app.analyticsPipeline.run(
      { headers: {}, clientIp: '10.0.0.1' },
      () => app.analyticsRoute.handle(validBody()),
    );
    expect(isProblemDetails(outcome)).toBe(false);
    expect(outcome).toMatchObject({
      event: 'step_view',
      route: '/estimate/scope',
    });
    expect((outcome as { consent_ts: string }).consent_ts).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it('returns 400 CONSENT_REQUIRED without consent_ts', async () => {
    const { consent_ts: _dropped, ...body } = validBody();
    const outcome = await app.analyticsPipeline.run(
      { headers: {}, clientIp: '10.0.0.2' },
      () => app.analyticsRoute.handle(body),
    );
    expect(isProblemDetails(outcome)).toBe(true);
    if (isProblemDetails(outcome)) {
      expect(outcome.status).toBe(400);
      expect(outcome.code).toBe('CONSENT_REQUIRED');
    }
  });

  it('returns 400 CONSENT_REQUIRED for a future-dated consent_ts', async () => {
    const outcome = await app.analyticsPipeline.run(
      { headers: {}, clientIp: '10.0.0.3' },
      () =>
        app.analyticsRoute.handle({
          ...validBody(),
          consent_ts: '2099-01-01T00:00:00.000Z',
        }),
    );
    expect(isProblemDetails(outcome)).toBe(true);
    if (isProblemDetails(outcome)) {
      expect(outcome.status).toBe(400);
      expect(outcome.code).toBe('CONSENT_REQUIRED');
    }
  });

  it('returns 400 for an event outside the allowlist', async () => {
    const outcome = await app.analyticsPipeline.run(
      { headers: {}, clientIp: '10.0.0.4' },
      () => app.analyticsRoute.handle({ ...validBody(), event: 'spy_on_user' }),
    );
    expect(isProblemDetails(outcome)).toBe(true);
    if (isProblemDetails(outcome)) {
      expect(outcome.status).toBe(400);
    }
  });

  it('rate-limits the analytics pipeline per IP', async () => {
    const run = () =>
      app.analyticsPipeline.run({ headers: {}, clientIp: '10.0.0.9' }, () =>
        app.analyticsRoute.handle(validBody()),
      );
    await run();
    await run();
    const outcome = await run();
    expect(isProblemDetails(outcome)).toBe(true);
    if (isProblemDetails(outcome)) {
      expect(outcome.status).toBe(429);
      expect(outcome.code).toBe('RATE_LIMITED');
    }
  });
});
