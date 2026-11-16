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
    // email/02: hourly 24h-nudge timer service.
    expect(app.nudgeService).toBeDefined();
    expect(app.communityStatsService).toBeDefined();
    expect(app.communityStatsRoute).toBeDefined();
    // neighbourhood/05: monthly refresh timer (service + manual admin route).
    expect(app.communityStatsRefreshService).toBeDefined();
    expect(app.communityStatsRefreshRoute).toBeDefined();
    expect(app.adminAuditStore).toBeDefined();
    expect(app.builderConfigService).toBeDefined();
    expect(app.embedConfigRoute).toBeDefined();
    // api-mcp/02: Socrata-backed property lookup (service + route wired).
    expect(app.propertyService).toBeDefined();
    expect(app.propertyRoute).toBeDefined();
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

describe('composition root — #788 bot challenge wiring', () => {
  /** In-memory SharedCounterStore so the shared limiters/cooldowns run without Postgres. */
  function memoryStore() {
    const rows = new Map<string, { count: number; windowStart: Date; expiresAt: Date }>();
    return {
      async increment(args: { key: string; windowStart: Date; expiresAt: Date }) {
        const row = rows.get(args.key);
        const count =
          row && row.windowStart.getTime() >= args.windowStart.getTime() ? row.count + 1 : 1;
        rows.set(args.key, { count, windowStart: args.windowStart, expiresAt: args.expiresAt });
        return count;
      },
      async read(key: string, now: Date) {
        const row = rows.get(key);
        return row && row.expiresAt > now ? row.count : 0;
      },
      async set(args: { key: string; windowStart: Date; expiresAt: Date }) {
        rows.set(args.key, { count: 1, windowStart: args.windowStart, expiresAt: args.expiresAt });
      },
      async deleteExpired() {
        return 0;
      },
    };
  }

  const ok = async () => 'ok';

  it('leaves the lead pipeline unchallenged while Turnstile is unconfigured', async () => {
    const app = createComposition(
      { ...TEST_ENV, LEAD_RATE_LIMIT_MAX_REQUESTS: '1' } as NodeJS.ProcessEnv,
      { rateLimitStore: memoryStore() },
    );
    const req = { headers: {}, clientIp: '203.0.113.9' };
    await app.leadPipeline.run(req, ok);
    const limited = await app.leadPipeline.run(req, ok);
    expect((limited as { code?: string }).code).toBe('RATE_LIMITED');
    expect(((await app.leadPipeline.run(req, ok)) as { code?: string }).code).toBe('RATE_LIMITED');
    await app.db.close();
  });

  it('challenges a tripped IP on the lead AND estimate pipelines once configured', async () => {
    const verified: string[] = [];
    const app = createComposition(
      {
        ...TEST_ENV,
        LEAD_RATE_LIMIT_MAX_REQUESTS: '1',
        TURNSTILE_SITE_KEY: 'site-key-test',
        TURNSTILE_SECRET_KEY: 'secret-test',
      } as NodeJS.ProcessEnv,
      {
        rateLimitStore: memoryStore(),
        challengeVerifier: {
          async verify(token) {
            verified.push(token);
            return token === 'good';
          },
        },
      },
    );
    const req = { headers: {}, clientIp: '203.0.113.10' };
    await app.leadPipeline.run(req, ok);
    await app.leadPipeline.run(req, ok); // trips the lead limiter
    const lead = (await app.leadPipeline.run(req, ok)) as {
      code?: string;
      challenge?: { siteKey: string };
    };
    expect(lead.code).toBe('CHALLENGE_REQUIRED');
    expect(lead.challenge?.siteKey).toBe('site-key-test');
    // The trip is per IP across the money/mail pipelines.
    const estimate = (await app.estimatePipeline.run(req, ok)) as { code?: string };
    expect(estimate.code).toBe('CHALLENGE_REQUIRED');
    // A verified token gets past the challenge (the estimate limiter is fresh).
    expect(
      await app.estimatePipeline.run(
        { headers: { 'x-turnstile-token': 'good' }, clientIp: '203.0.113.10' },
        ok,
      ),
    ).toBe('ok');
    expect(verified).toEqual(['good']);
    await app.db.close();
  });
});
