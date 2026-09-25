import { describe, expect, it } from 'vitest';
import { createComposition } from '../src/composition';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

const HEALTHY = {
  status: 'ok',
  service: 'feasly-api',
  version: '0.1.0',
  checks: { database: 'ok' },
};

// The test env has no live Postgres, so tests inject a healthy probe;
// production wiring always pings the real pool (see the default-wiring test).
const HEALTHY_PING = { dbPing: async () => {} };

describe('composition root', () => {
  it('resolves every wired service (none undefined)', () => {
    const app = createComposition(TEST_ENV);
    expect(app.config).toBeDefined();
    expect(app.db).toBeDefined();
    expect(app.rateLimiter).toBeDefined();
    expect(app.requestPipeline).toBeDefined();
    expect(app.leadRateLimiter).toBeDefined();
    expect(app.leadPipeline).toBeDefined();
    // consumer/03: dedicated estimates pipeline (20/hr/IP + per-tenant).
    expect(app.estimateRateLimiter).toBeDefined();
    expect(app.estimateTenantRateLimiter).toBeDefined();
    expect(app.estimatePipeline).toBeDefined();
    expect(app.healthService).toBeDefined();
    expect(app.healthRoute).toBeDefined();
    expect(app.estimateStore).toBeDefined();
    expect(app.estimateService).toBeDefined();
    expect(app.estimateRoute).toBeDefined();
    expect(app.leadStore).toBeDefined();
    expect(app.leadService).toBeDefined();
    expect(app.leadRoute).toBeDefined();
    // email/03: one-click unsubscribe center (service + route wired).
    expect(app.unsubscribeService).toBeDefined();
    expect(app.unsubscribeRoute).toBeDefined();
    expect(app.communityStatsService).toBeDefined();
    expect(app.communityStatsRoute).toBeDefined();
  });

  it('injects config into the health service', async () => {
    const app = createComposition(TEST_ENV, HEALTHY_PING);
    await expect(app.healthService.check()).resolves.toEqual(HEALTHY);
  });

  it('health route delegates to the health service interface', async () => {
    const app = createComposition(TEST_ENV, HEALTHY_PING);
    await expect(app.healthRoute.handle()).resolves.toEqual(HEALTHY);
  });

  it('defaults to probing the real pool (no not-configured in production wiring)', async () => {
    const app = createComposition(TEST_ENV);
    // No Postgres listens in the test env, so the real probe fails —
    // the point is the composition wires a REAL probe, never not-configured.
    await expect(app.healthService.check()).resolves.toEqual({
      status: 'degraded',
      service: 'feasly-api',
      version: '0.1.0',
      checks: { database: 'unreachable' },
    });
  });
});
