import { describe, expect, it } from 'vitest';
import { createComposition } from '../src/composition';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

describe('composition root', () => {
  it('resolves every wired service (none undefined)', () => {
    const app = createComposition(TEST_ENV);
    expect(app.config).toBeDefined();
    expect(app.healthService).toBeDefined();
    expect(app.healthRoute).toBeDefined();
  });

  it('injects config into the health service', async () => {
    const app = createComposition(TEST_ENV);
    await expect(app.healthService.check()).resolves.toEqual({
      status: 'ok',
      service: 'feasly-api',
      version: '0.1.0',
    });
  });

  it('health route delegates to the health service interface', async () => {
    const app = createComposition(TEST_ENV);
    await expect(app.healthRoute.handle()).resolves.toEqual({
      status: 'ok',
      service: 'feasly-api',
      version: '0.1.0',
    });
  });
});
