import { describe, expect, it } from 'vitest';
import { version as packageVersion } from '../package.json';
import { loadConfig } from '../src/config';

const VALID_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a valid env into typed config with defaults applied', () => {
    const config = loadConfig(VALID_ENV);
    expect(config).toEqual({
      serviceName: 'feasly-api',
      version: packageVersion,
      env: 'test',
      databaseUrl: 'postgresql://user:pass@localhost:5432/feasly',
      db: { poolMaxSize: 5 },
      rateLimit: { windowMs: 60_000, maxRequests: 100, maxTrackedKeys: 10_000 },
      lead: {
        rateLimit: { windowMs: 60_000, maxRequests: 10 },
        dedupWindowDays: 90,
      },
      auth: { jwtTtlSeconds: 3_600, magicLinkTtlSeconds: 900 },
      corsOrigins: [],
      queues: { email: 'email-queue', pdf: 'pdf-queue', sheets: 'sheets-queue' },
      health: { dbTimeoutMs: 2_000 },
    });
  });

  it('composes DATABASE_URL from POSTGRES_* pieces when it is absent', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      POSTGRES_HOST: 'feasly-dev-pg-abc.postgres.database.azure.com',
      POSTGRES_DB: 'feasly',
      POSTGRES_USER: 'feaslyadmin',
      POSTGRES_PASSWORD: 'p@ss:w/rd?',
    } as NodeJS.ProcessEnv);
    expect(config.databaseUrl).toBe(
      'postgresql://feaslyadmin:p%40ss%3Aw%2Frd%3F@feasly-dev-pg-abc.postgres.database.azure.com:5432/feasly?sslmode=require',
    );
  });

  it('prefers an explicit DATABASE_URL over POSTGRES_* pieces', () => {
    const config = loadConfig({
      ...VALID_ENV,
      POSTGRES_HOST: 'other.example.com',
      POSTGRES_DB: 'feasly',
      POSTGRES_USER: 'feaslyadmin',
      POSTGRES_PASSWORD: 'x',
    });
    expect(config.databaseUrl).toBe('postgresql://user:pass@localhost:5432/feasly');
  });

  it('fails fast naming DATABASE_URL when neither form is configured', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', POSTGRES_HOST: 'h' } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
  });

  it('fails fast naming DATABASE_URL when it is missing', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a non-Postgres DATABASE_URL naming the variable', () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects a negative TTL naming the variable', () => {
    expect(() => loadConfig({ ...VALID_ENV, JWT_TTL_SECONDS: '-5' })).toThrow(
      /JWT_TTL_SECONDS/,
    );
  });

  it('rejects a non-numeric rate limit naming the variable', () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, RATE_LIMIT_MAX_REQUESTS: 'many' }),
    ).toThrow(/RATE_LIMIT_MAX_REQUESTS/);
  });

  it('rejects an invalid NODE_ENV naming the variable', () => {
    expect(() => loadConfig({ ...VALID_ENV, NODE_ENV: 'bogus' })).toThrow(
      /NODE_ENV/,
    );
  });

  it('treats empty-string values as unset so defaults apply', () => {
    const config = loadConfig({
      ...VALID_ENV,
      RATE_LIMIT_WINDOW_MS: '',
      CORS_ORIGINS: '',
    });
    expect(config.rateLimit.windowMs).toBe(60_000);
    expect(config.corsOrigins).toEqual([]);
  });

  it('parses CORS_ORIGINS into a trimmed list', () => {
    const config = loadConfig({
      ...VALID_ENV,
      CORS_ORIGINS: ' https://app.feasly.com,https://admin.feasly.com ,,',
    });
    expect(config.corsOrigins).toEqual([
      'https://app.feasly.com',
      'https://admin.feasly.com',
    ]);
  });

  it('coerces numeric strings to numbers', () => {
    const config = loadConfig({
      ...VALID_ENV,
      RATE_LIMIT_MAX_REQUESTS: '10',
      MAGIC_LINK_TTL_SECONDS: '600',
    });
    expect(config.rateLimit.maxRequests).toBe(10);
    expect(config.auth.magicLinkTtlSeconds).toBe(600);
  });

  it('version is the single source of truth: mirrors package.json', () => {
    expect(loadConfig(VALID_ENV).version).toBe(packageVersion);
  });
});
