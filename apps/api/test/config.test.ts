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
      estimate: {
        rateLimit: { windowMs: 3_600_000, maxRequests: 20 },
        tenantRateLimit: { windowMs: 3_600_000, maxRequests: 20 },
      },
      analytics: {
        rateLimit: { windowMs: 60_000, maxRequests: 300 },
      },
      auth: { jwtTtlSeconds: 3_600, magicLinkTtlSeconds: 604_800 },
      corsOrigins: [],
      queues: { email: 'email-queue', pdf: 'pdf-queue', sheets: 'sheets-queue' },
      email: {
        provider: 'log',
        fromAddress: 'noreply@feasly.example',
        fromName: 'Feasly',
        postmarkServerToken: undefined,
        postmarkEndpoint: 'https://api.postmarkapp.com/email',
        acsConnectionString: undefined,
        appBaseUrl: 'https://feasly.example',
        unsubscribeUrlBase: 'https://feasly.example/unsubscribe',
        unsubscribeTokenSecret: undefined,
        unsubscribeTokenTtlSeconds: 2_592_000,
        opsInbox: 'karanbirsingh667@gmail.com',
        logLinks: true,
      },
      health: { dbTimeoutMs: 2_000 },
      costEngine: { allowDraftCostData: false },
      propertyData: {
        socrataBaseUrl: 'https://data.calgary.ca',
        datasetId: '4bsw-nn7w',
        cacheTtlMs: 300_000,
        httpTimeoutMs: 15_000,
        searchRowLimit: 50,
        suggestionLimit: 8,
      },
      billing: {
        model: 'commission',
        commissionRate: 0.01,
        attributionWindowDays: 365,
        reportingSlaDays: 14,
        flatPlanName: 'Builder Standard',
        flatMonthlyCents: 30_000,
        flatCurrency: 'CAD',
      },
    });
  });

  it('reads the reno draft-data flag from COST_ENGINE_ALLOW_DRAFT', () => {
    const config = loadConfig({ ...VALID_ENV, COST_ENGINE_ALLOW_DRAFT: 'true' });
    expect(config.costEngine.allowDraftCostData).toBe(true);
  });

  it('reads the billing model, rate, window, and SLA from env', () => {
    const config = loadConfig({
      ...VALID_ENV,
      BILLING_MODEL: 'flat',
      BILLING_COMMISSION_RATE: '0.02',
      BILLING_ATTRIBUTION_WINDOW_DAYS: '180',
      BILLING_REPORTING_SLA_DAYS: '7',
      BILLING_FLAT_PLAN_NAME: 'Builder Pro',
      BILLING_FLAT_MONTHLY_CENTS: '45000',
      BILLING_FLAT_CURRENCY: 'usd',
    });
    expect(config.billing).toEqual({
      model: 'flat',
      commissionRate: 0.02,
      attributionWindowDays: 180,
      reportingSlaDays: 7,
      flatPlanName: 'Builder Pro',
      flatMonthlyCents: 45_000,
      flatCurrency: 'USD',
    });
  });

  it('rejects an unknown billing model naming the variable', () => {
    expect(() => loadConfig({ ...VALID_ENV, BILLING_MODEL: 'per-lead' })).toThrow(
      /BILLING_MODEL/,
    );
  });

  it('rejects a commission rate above 100% naming the variable', () => {
    expect(() => loadConfig({ ...VALID_ENV, BILLING_COMMISSION_RATE: '1.5' })).toThrow(
      /BILLING_COMMISSION_RATE/,
    );
  });

  it('rejects a zero attribution window naming the variable', () => {
    expect(() => loadConfig({ ...VALID_ENV, BILLING_ATTRIBUTION_WINDOW_DAYS: '0' })).toThrow(
      /BILLING_ATTRIBUTION_WINDOW_DAYS/,
    );
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

  it('estimates rate limits default to the frozen registry values (TECH_PLAN.md §13.3: 20/hr/IP)', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.estimate.rateLimit).toEqual({
      windowMs: 3_600_000,
      maxRequests: 20,
    });
    expect(config.estimate.tenantRateLimit).toEqual({
      windowMs: 3_600_000,
      maxRequests: 20,
    });
  });

  it('estimates rate limits are env-overridable', () => {
    const config = loadConfig({
      ...VALID_ENV,
      ESTIMATE_RATE_LIMIT_MAX_REQUESTS: '5',
      ESTIMATE_TENANT_RATE_LIMIT_MAX_REQUESTS: '7',
    });
    expect(config.estimate.rateLimit.maxRequests).toBe(5);
    expect(config.estimate.tenantRateLimit.maxRequests).toBe(7);
  });

  it('unsubscribe token config: 30-day default TTL, secret optional (fail-closed at use)', () => {
    const defaults = loadConfig(VALID_ENV);
    expect(defaults.email.unsubscribeTokenTtlSeconds).toBe(2_592_000);
    expect(defaults.email.unsubscribeTokenSecret).toBeUndefined();

    const configured = loadConfig({
      ...VALID_ENV,
      UNSUBSCRIBE_TOKEN_SECRET: 'kv-ref',
      UNSUBSCRIBE_TOKEN_TTL_SECONDS: '86400',
    });
    expect(configured.email.unsubscribeTokenSecret).toBe('kv-ref');
    expect(configured.email.unsubscribeTokenTtlSeconds).toBe(86400);
  });

  it('version is the single source of truth: mirrors package.json', () => {
    expect(loadConfig(VALID_ENV).version).toBe(packageVersion);
  });
});
