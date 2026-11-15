/**
 * #729 AC1: rotating a spoofed `X-Forwarded-For` prefix must not mint a
 * fresh rate-limit bucket.
 *
 * Drives the real estimate adapter through a REAL pipeline wired like
 * production (shared per-IP limiter at the configured ceiling) — only the
 * composition is swapped so no database or cost engine is needed. Every
 * request comes from the same socket: the platform appends the same peer
 * address, while the caller-controlled left part changes each time.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import * as realMiddleware from '../src/middleware';
import { createFakeSharedCounterStore } from './fake-shared-counter-store';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv);
const CEILING = config.estimate.rateLimit.maxRequests;

const store = createFakeSharedCounterStore();
const routeHandle = vi.fn(async () => ({ estimateId: 'e1' }));
const fakeApp = {
  estimatePipeline: realMiddleware.createRequestPipeline({
    rateLimiter: realMiddleware.createSharedRateLimiter({
      store,
      scope: 'estimate:ip',
      windowMs: config.estimate.rateLimit.windowMs,
      maxRequests: CEILING,
      sweepIntervalMs: config.sharedRateLimit.sweepIntervalMs,
      fallback: realMiddleware.createRateLimiter({
        windowMs: config.estimate.rateLimit.windowMs,
        maxRequests: CEILING,
        maxTrackedKeys: config.rateLimit.maxTrackedKeys,
      }),
    }),
    logger: () => {},
  }),
  estimateRoute: { handle: routeHandle },
  withApiKeyRateLimit: async (
    _headers: unknown,
    _correlationId: string,
    _options: unknown,
    handler: () => Promise<unknown>,
  ) => handler(),
};

vi.mock('../src/index', async () => ({
  createComposition: () => fakeApp,
  loadConfig: () => ({ corsOrigins: [] }),
  middleware: await vi.importActual('../src/middleware'),
}));

import { estimateHandler } from '../src/functions/estimate';

describe('estimate rate limit vs spoofed X-Forwarded-For (#729 AC1)', () => {
  it('limits 30 requests from one socket at the configured ceiling', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const ctx = { res: undefined as { status: number } | undefined, log: () => {} };
      await estimateHandler(ctx, {
        method: 'POST',
        // Spoofed left-most hop rotates; the platform-appended peer is fixed.
        headers: { 'x-forwarded-for': `10.${i}.${i}.${i}, 203.0.113.50` },
        body: { address: '123 Main St NW' },
      });
      statuses.push(ctx.res?.status ?? 0);
    }
    expect(CEILING).toBeLessThan(30);
    expect(statuses.filter((s) => s === 429)).toHaveLength(30 - CEILING);
    expect(statuses.slice(0, CEILING).every((s) => s !== 429)).toBe(true);
    expect(routeHandle).toHaveBeenCalledTimes(CEILING);
  });
});
