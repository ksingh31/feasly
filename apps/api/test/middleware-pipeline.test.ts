import { describe, expect, it, vi } from 'vitest';
import { ensureCorrelationId } from '../src/middleware/correlation';
import { ErrorCodes, isProblemDetails } from '../src/middleware/errors';
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
});

describe('ensureCorrelationId', () => {
  it('uses the first value of a repeated header', () => {
    expect(
      ensureCorrelationId({ 'x-correlation-id': ['a', 'b'] }),
    ).toBe('a');
  });
});
