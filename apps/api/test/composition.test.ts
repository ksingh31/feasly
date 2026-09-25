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
  checks: { database: 'not-configured' },
};

describe('composition root', () => {
  it('resolves every wired service (none undefined)', () => {
    const app = createComposition(TEST_ENV);
    expect(app.config).toBeDefined();
    expect(app.db).toBeDefined();
    expect(app.rateLimiter).toBeDefined();
    expect(app.requestPipeline).toBeDefined();
    expect(app.leadRateLimiter).toBeDefined();
    expect(app.leadPipeline).toBeDefined();
    expect(app.healthService).toBeDefined();
    expect(app.healthRoute).toBeDefined();
    expect(app.estimateStore).toBeDefined();
    expect(app.estimateService).toBeDefined();
    expect(app.estimateRoute).toBeDefined();
    expect(app.leadStore).toBeDefined();
    expect(app.leadService).toBeDefined();
    expect(app.leadRoute).toBeDefined();
    expect(app.communityStatsService).toBeDefined();
    expect(app.communityStatsRoute).toBeDefined();
  });

  it('injects config into the health service', async () => {
    const app = createComposition(TEST_ENV);
    await expect(app.healthService.check()).resolves.toEqual(HEALTHY);
  });

  it('health route delegates to the health service interface', async () => {
    const app = createComposition(TEST_ENV);
    await expect(app.healthRoute.handle()).resolves.toEqual(HEALTHY);
  });
});
