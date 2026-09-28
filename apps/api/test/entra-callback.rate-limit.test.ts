/**
 * Entra callback rate-limit test (auth/02, acceptance criterion 4).
 *
 * Mirrors the composition wiring: the callback adapter runs the route
 * handler through the dedicated callback pipeline whose limiter is
 * 10 attempts per IP per 15 min (frozen registry). The 11th attempt gets
 * 429 RATE_LIMITED and the service is never invoked for it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../src/middleware/rate-limit';
import { createRequestPipeline } from '../src/middleware/pipeline';
import {
  ErrorCodes,
  isProblemDetails,
} from '../src/middleware/errors';
import { createAdminEntraCallbackRoute } from '../src/routes/admin/entra-callback';

const CALLBACK_WINDOW_MS = 900_000; // 15 min — matches config default
const CALLBACK_MAX_REQUESTS = 10;

function testCallbackPipeline() {
  const entraCallback = {
    handleCallback: vi.fn(async () => ({
      authenticated: true as const,
      user: { email: 'admin@example.com', name: 'A', staffRole: 'admin' },
      sessionToken: 'token',
    })),
  };
  const route = createAdminEntraCallbackRoute({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entraCallback: entraCallback as any,
    adminSessionTtlSeconds: 604_800,
  });
  // Same shape as the composition's entraCallbackPipeline.
  const pipeline = createRequestPipeline({
    rateLimiter: createRateLimiter({
      windowMs: CALLBACK_WINDOW_MS,
      maxRequests: CALLBACK_MAX_REQUESTS,
      maxTrackedKeys: 1000,
    }),
    logger: () => {},
  });
  return { pipeline, entraCallback, route };
}

const REQUEST = { headers: {}, clientIp: '203.0.113.9' };
const BODY = {
  code: 'code',
  codeVerifier: 'verifier',
  redirectUri: 'https://app.example/admin/auth/callback',
};

describe('entra callback rate limit (10 per IP per 15 min)', () => {
  it('the 11th attempt → 429 RATE_LIMITED, service not invoked', async () => {
    const { pipeline, entraCallback, route } = testCallbackPipeline();
    const handler = () => route.callback(BODY);

    for (let i = 0; i < CALLBACK_MAX_REQUESTS; i += 1) {
      const result = await pipeline.run(REQUEST, handler);
      expect(isProblemDetails(result)).toBe(false);
    }
    const limited = await pipeline.run(REQUEST, handler);

    expect(entraCallback.handleCallback).toHaveBeenCalledTimes(CALLBACK_MAX_REQUESTS);
    expect(isProblemDetails(limited)).toBe(true);
    if (isProblemDetails(limited)) {
      expect(limited.status).toBe(429);
      expect(limited.code).toBe(ErrorCodes.RATE_LIMITED);
      expect(limited.retryable).toBe(true);
    }
  });

  it('limits are per client IP', async () => {
    const { pipeline, entraCallback, route } = testCallbackPipeline();
    const handler = () => route.callback(BODY);

    for (let i = 0; i < CALLBACK_MAX_REQUESTS; i += 1) {
      await pipeline.run(REQUEST, handler);
    }
    const otherIp = await pipeline.run(
      { headers: {}, clientIp: '198.51.100.7' },
      handler,
    );
    expect(isProblemDetails(otherIp)).toBe(false);
    expect(entraCallback.handleCallback).toHaveBeenCalledTimes(CALLBACK_MAX_REQUESTS + 1);
  });
});
