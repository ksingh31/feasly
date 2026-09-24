import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createHealthService } from '../src/services/health.service';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

describe('createHealthService — database check (BE0-003)', () => {
  it('reports not-configured when no dbPing is wired (pre BE-1)', async () => {
    const service = createHealthService({ config: loadConfig(TEST_ENV) });
    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      service: 'feasly-api',
      version: '0.1.0',
      checks: { database: 'not-configured' },
    });
  });

  it('reports ok when the ping resolves', async () => {
    const service = createHealthService({
      config: loadConfig(TEST_ENV),
      dbPing: async () => {},
    });
    const status = await service.check();
    expect(status.status).toBe('ok');
    expect(status.checks.database).toBe('ok');
  });

  it('reports degraded (not a 500) when the ping rejects', async () => {
    const service = createHealthService({
      config: loadConfig(TEST_ENV),
      dbPing: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const status = await service.check();
    expect(status.status).toBe('degraded');
    expect(status.checks.database).toBe('unreachable');
  });

  it('a hanging ping becomes unreachable after the configured timeout', async () => {
    const config = loadConfig({ ...TEST_ENV, HEALTH_DB_TIMEOUT_MS: '50' });
    const service = createHealthService({
      config,
      dbPing: () => new Promise<void>(() => {}), // never settles
    });
    const started = Date.now();
    const status = await service.check();
    expect(status.status).toBe('degraded');
    expect(status.checks.database).toBe('unreachable');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
