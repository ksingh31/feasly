import { describe, expect, it, vi } from 'vitest';
import { ensureCorrelationId } from '../src/middleware/correlation';
import {
  ErrorCodes,
  isProblemDetails,
  problemResponseHeaders,
} from '../src/middleware/errors';
import { createRateLimiter } from '../src/middleware/rate-limit';
import {
  createRequestPipeline,
  type LogEntry,
  type PipelineRequest,
} from '../src/middleware/pipeline';

function testPipeline(maxRequests = 1000) {
  const logs: LogEntry[] = [];
  const pipeline = createRequestPipeline({
    rateLimiter: createRateLimiter({
      windowMs: 60_000,
      maxRequests,
      maxTrackedKeys: 1000,
    }),
    logger: (entry) => {
      logs.push(entry);
    },
  });
  return { pipeline, logs };
}

const REQUEST: PipelineRequest = { headers: {}, clientIp: '1.2.3.4' };

describe('createRequestPipeline — correlation', () => {
  it('propagates an incoming x-correlation-id to handler and errors', async () => {
    const { pipeline } = testPipeline();
    const seen: string[] = [];
    const result = await pipeline.run(
      { headers: { 'x-correlation-id': 'client-123' }, clientIp: '1.2.3.4' },
      async (ctx) => {
        seen.push(ctx.correlationId);
        throw new Error('rogue');
      },
    );
    expect(seen).toEqual(['client-123']);
    expect(isProblemDetails(result)).toBe(true);
    if (isProblemDetails(result)) {
      expect(result.correlationId).toBe('client-123');
    }
  });

  it('generates a unique UUID when the header is absent', async () => {
    const { pipeline } = testPipeline();
    const seen: string[] = [];
    const handler = async (ctx: { correlationId: string }) => {
      seen.push(ctx.correlationId);
      return 'ok';
    };
    await pipeline.run(REQUEST, handler);
    await pipeline.run({ headers: {}, clientIp: '9.9.9.9' }, handler);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    for (const id of seen) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it('treats a blank header as absent', async () => {
    const { pipeline } = testPipeline();
    let seen = '';
    await pipeline.run(
      { headers: { 'x-correlation-id': '   ' }, clientIp: '1.2.3.4' },
      async (ctx) => {
        seen = ctx.correlationId;
        return 'ok';
      },
    );
    expect(seen).not.toBe('   ');
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('createRequestPipeline — errors', () => {
  it('an unknown throw becomes a 500 ProblemDetails with the correlation ID', async () => {
    const { pipeline, logs } = testPipeline();
    const result = await pipeline.run(REQUEST, async () => {
      throw new Error('db password=hunter2');
    });
    expect(isProblemDetails(result)).toBe(true);
    if (isProblemDetails(result)) {
      expect(result.status).toBe(500);
      expect(result.code).toBe('INTERNAL_ERROR');
      expect(result.correlationId).toHaveLength(36);
      expect(JSON.stringify(result)).not.toContain('hunter2');
    }
    // …while the full details land in the server log with the correlation ID
    const errorLog = logs.find((l) => l.level === 'error');
    expect(errorLog).toBeDefined();
    expect(errorLog?.message).toContain('hunter2');
    expect(errorLog?.correlationId).toHaveLength(36);
  });
});

describe('createRequestPipeline — rate limiting', () => {
  it('the 3rd request in the window returns 429 RATE_LIMITED without calling the handler', async () => {
    const { pipeline, logs } = testPipeline(2);
    const handler = vi.fn(async () => 'ok');

    expect(isProblemDetails(await pipeline.run(REQUEST, handler))).toBe(false);
    expect(isProblemDetails(await pipeline.run(REQUEST, handler))).toBe(false);
    const limited = await pipeline.run(REQUEST, handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(isProblemDetails(limited)).toBe(true);
    if (isProblemDetails(limited)) {
      expect(limited.status).toBe(429);
      expect(limited.code).toBe(ErrorCodes.RATE_LIMITED);
      expect(limited.retryable).toBe(true);
      expect(limited.retryAfterMs).toBeGreaterThan(0);
    }
    expect(logs.some((l) => l.level === 'warn')).toBe(true);
  });

  it('limits per client IP', async () => {
    const { pipeline } = testPipeline(1);
    const handler = vi.fn(async () => 'ok');
    await pipeline.run(REQUEST, handler);
    const other = await pipeline.run(
      { headers: {}, clientIp: '5.6.7.8' },
      handler,
    );
    expect(isProblemDetails(other)).toBe(false);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('the 11th lead-submit in 60s returns 429 with Retry-After (config-shaped limit)', async () => {
    // Mirrors the composition defaults: LEAD_RATE_LIMIT_MAX_REQUESTS=10,
    // LEAD_RATE_LIMIT_WINDOW_MS=60_000. The limit is env-configurable; the
    // pipeline only ever sees the injected numbers.
    const { pipeline } = testPipeline(10);
    const handler = vi.fn(async () => 'ok');
    for (let i = 0; i < 10; i += 1) {
      expect(isProblemDetails(await pipeline.run(REQUEST, handler))).toBe(false);
    }
    const limited = await pipeline.run(REQUEST, handler);
    expect(handler).toHaveBeenCalledTimes(10);
    expect(isProblemDetails(limited)).toBe(true);
    if (isProblemDetails(limited)) {
      expect(limited.status).toBe(429);
      expect(limited.code).toBe(ErrorCodes.RATE_LIMITED);
      const headers = problemResponseHeaders(limited);
      expect(headers['Retry-After']).toMatch(/^[1-9]\d*$/);
    }
  });

  it('rate-limit logs carry an IP hash, never the raw IP', async () => {
    const { pipeline, logs } = testPipeline(1);
    const handler = vi.fn(async () => 'ok');
    const v4 = '203.0.113.7';
    const v6 = '2001:db8::1';
    await pipeline.run({ headers: {}, clientIp: v4 }, handler);
    await pipeline.run({ headers: {}, clientIp: v4 }, handler);
    await pipeline.run({ headers: {}, clientIp: v6 }, handler);
    await pipeline.run({ headers: {}, clientIp: v6 }, handler);
    const warn = logs.filter((l) => l.level === 'warn');
    expect(warn).toHaveLength(2);
    const dump = JSON.stringify(warn);
    expect(dump).not.toContain(v4);
    expect(dump).not.toContain(v6);
    expect(dump).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(dump).not.toContain('2001:db8');
    for (const entry of warn) {
      expect(entry.message).toMatch(/clientIpHash=[0-9a-f]{64}/);
    }
  });

  it('supports composite limiter keys (ip::tenant) for embed aggregation', async () => {
    const logs: LogEntry[] = [];
    const pipeline = createRequestPipeline({
      rateLimiter: createRateLimiter({
        windowMs: 60_000,
        maxRequests: 1,
        maxTrackedKeys: 1000,
      }),
      keyFor: (request) =>
        `${request.clientIp ?? 'unknown'}::${request.tenantKey ?? '-'}`,
      logger: (entry) => {
        logs.push(entry);
      },
    });
    const handler = vi.fn(async () => 'ok');
    const first = await pipeline.run(
      { headers: {}, clientIp: '1.2.3.4', tenantKey: 'elite-craft' },
      handler,
    );
    const second = await pipeline.run(
      { headers: {}, clientIp: '1.2.3.4', tenantKey: 'elite-craft' },
      handler,
    );
    // Same IP, different tenant → a different limiter key.
    const third = await pipeline.run(
      { headers: {}, clientIp: '1.2.3.4', tenantKey: 'other-builder' },
      handler,
    );
    expect(isProblemDetails(first)).toBe(false);
    expect(isProblemDetails(second)).toBe(true);
    expect(isProblemDetails(third)).toBe(false);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('createRequestPipeline — extra limiters (consumer/03)', () => {
  /**
   * Mirrors the estimate composition: 20/hr per IP (primary) + 20/hr per
   * tenant for embed traffic (extra). The limits are env-configurable; the
   * pipeline only ever sees the injected numbers.
   */
  function estimatePipeline(maxRequests = 20, tenantMax = 20) {
    const logs: LogEntry[] = [];
    const pipeline = createRequestPipeline({
      rateLimiter: createRateLimiter({
        windowMs: 3_600_000,
        maxRequests,
        maxTrackedKeys: 1000,
      }),
      extraLimiters: [
        {
          limiter: createRateLimiter({
            windowMs: 3_600_000,
            maxRequests: tenantMax,
            maxTrackedKeys: 1000,
          }),
          keyFor: (request) =>
            request.tenantKey === undefined
              ? undefined
              : `tenant:${request.tenantKey}`,
          label: 'tenant',
        },
      ],
      logger: (entry) => {
        logs.push(entry);
      },
    });
    return { pipeline, logs };
  }

  const EMBED: PipelineRequest = {
    headers: {},
    clientIp: '1.2.3.4',
    tenantKey: 'elite-craft',
  };

  it('21st estimate in an hour from one IP → 429 with Retry-After + RATE_LIMITED', async () => {
    const { pipeline } = estimatePipeline();
    const handler = vi.fn(async () => 'ok');
    for (let i = 0; i < 20; i += 1) {
      expect(isProblemDetails(await pipeline.run(REQUEST, handler))).toBe(
        false,
      );
    }
    const limited = await pipeline.run(REQUEST, handler);
    expect(handler).toHaveBeenCalledTimes(20);
    expect(isProblemDetails(limited)).toBe(true);
    if (isProblemDetails(limited)) {
      expect(limited.status).toBe(429);
      expect(limited.code).toBe(ErrorCodes.RATE_LIMITED);
      expect(limited.retryAfterMs).toBeGreaterThan(0);
      const headers = problemResponseHeaders(limited);
      expect(headers['Retry-After']).toMatch(/^[1-9]\d*$/);
    }
  });

  it('a real-user flow (≤ 5 estimates/hr) never hits the limit', async () => {
    const { pipeline } = estimatePipeline();
    const handler = vi.fn(async () => 'ok');
    for (let i = 0; i < 5; i += 1) {
      expect(isProblemDetails(await pipeline.run(REQUEST, handler))).toBe(
        false,
      );
    }
    expect(handler).toHaveBeenCalledTimes(5);
  });

  it('embed estimates count against both IP and tenant: two IPs, one tenant → tenant cap applies', async () => {
    // Tenant budget is 2 here so the test stays small; the IP budget (20)
    // is never reached by either IP alone.
    const { pipeline } = estimatePipeline(20, 2);
    const handler = vi.fn(async () => 'ok');
    const ipA = { ...EMBED, clientIp: '1.2.3.4' };
    const ipB = { ...EMBED, clientIp: '5.6.7.8' };
    expect(isProblemDetails(await pipeline.run(ipA, handler))).toBe(false);
    expect(isProblemDetails(await pipeline.run(ipB, handler))).toBe(false);
    // Third request — from a FRESH IP — is denied by the tenant bucket.
    const denied = await pipeline.run(
      { ...EMBED, clientIp: '9.10.11.12' },
      handler,
    );
    expect(handler).toHaveBeenCalledTimes(2);
    expect(isProblemDetails(denied)).toBe(true);
    if (isProblemDetails(denied)) {
      expect(denied.status).toBe(429);
      expect(denied.code).toBe(ErrorCodes.RATE_LIMITED);
    }
  });

  it('non-embed traffic (no tenantKey) skips the tenant limiter', async () => {
    const { pipeline } = estimatePipeline(20, 1);
    const handler = vi.fn(async () => 'ok');
    // Tenant budget is 1, but plain-IP traffic has no tenant key — all 20
    // IP-budget requests go through.
    for (let i = 0; i < 20; i += 1) {
      expect(isProblemDetails(await pipeline.run(REQUEST, handler))).toBe(
        false,
      );
    }
    expect(handler).toHaveBeenCalledTimes(20);
  });

  it('tenant-denial logs carry a key hash, never the raw tenant key', async () => {
    const { pipeline, logs } = estimatePipeline(20, 1);
    const handler = vi.fn(async () => 'ok');
    await pipeline.run(EMBED, handler);
    await pipeline.run(EMBED, handler);
    const warn = logs.filter((l) => l.level === 'warn');
    expect(warn).toHaveLength(1);
    const dump = JSON.stringify(warn);
    expect(dump).not.toContain('elite-craft');
    expect(warn[0]?.message).toMatch(/dimension=tenant keyHash=[0-9a-f]{64}/);
  });
});

describe('ensureCorrelationId', () => {
  it('uses the first value of a repeated header', () => {
    expect(
      ensureCorrelationId({ 'x-correlation-id': ['a', 'b'] }),
    ).toBe('a');
  });
});
