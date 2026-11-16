/**
 * #788 — invisible bot protection: Turnstile required only after a
 * rate-limit trip (fails closed), plus the pure time-to-submit check.
 */
import { describe, expect, it, vi } from 'vitest';
import { isTooFastSubmission } from '../src/lib/bot-timing';
import {
  createBotChallengeGate,
  hasBearerCredential,
  readChallengeToken,
  type ChallengeVerifier,
} from '../src/middleware/bot-challenge';
import { ErrorCodes, isProblemDetails } from '../src/middleware/errors';
import { createRequestPipeline, type LogEntry } from '../src/middleware/pipeline';
import { createRateLimiter } from '../src/middleware/rate-limit';
import {
  createInMemoryCooldown,
  createSharedCooldown,
  type SharedCounterStore,
} from '../src/middleware/shared-rate-limit';
import { createTurnstileVerifier } from '../src/services/turnstile.service';

const SITE_KEY = '0x4AAAAAAAtestsitekey';

function verifierAccepting(validToken: string): ChallengeVerifier & {
  calls: Array<{ token: string; remoteIp: string | undefined }>;
} {
  const calls: Array<{ token: string; remoteIp: string | undefined }> = [];
  return {
    calls,
    async verify(token, remoteIp) {
      calls.push({ token, remoteIp });
      return token === validToken;
    },
  };
}

function gatedPipeline(verifier: ChallengeVerifier, maxRequests = 2) {
  const logs: LogEntry[] = [];
  const gate = createBotChallengeGate({
    trips: createInMemoryCooldown(86_400_000),
    verifier,
    siteKey: SITE_KEY,
  });
  const pipeline = createRequestPipeline({
    rateLimiter: createRateLimiter({ windowMs: 60_000, maxRequests, maxTrackedKeys: 100 }),
    challenge: gate,
    logger: (entry) => logs.push(entry),
  });
  return { pipeline, gate, logs };
}

const ok = async () => 'ok';

describe('isTooFastSubmission (#788)', () => {
  it('flags values under the minimum', () => {
    expect(isTooFastSubmission(100, 3_000)).toBe(true);
    expect(isTooFastSubmission(2_999, 3_000)).toBe(true);
  });
  it('passes values at or over the minimum', () => {
    expect(isTooFastSubmission(3_000, 3_000)).toBe(false);
    expect(isTooFastSubmission(60_000, 3_000)).toBe(false);
  });
  it('treats a missing value as not too fast', () => {
    expect(isTooFastSubmission(undefined, 3_000)).toBe(false);
  });
  it('treats negative or non-finite values as too fast', () => {
    expect(isTooFastSubmission(-1, 3_000)).toBe(true);
    expect(isTooFastSubmission(Number.NaN, 3_000)).toBe(true);
    expect(isTooFastSubmission(Number.POSITIVE_INFINITY, 3_000)).toBe(true);
  });
  it('is disabled at 0', () => {
    expect(isTooFastSubmission(0, 0)).toBe(false);
    expect(isTooFastSubmission(-1, 0)).toBe(false);
  });
});

describe('header helpers (#788)', () => {
  it('reads the Turnstile token case-insensitively, ignoring blanks', () => {
    expect(readChallengeToken({ 'x-turnstile-token': ' abc ' })).toBe('abc');
    expect(readChallengeToken({ 'X-Turnstile-Token': ['def'] })).toBe('def');
    expect(readChallengeToken({ 'x-turnstile-token': '   ' })).toBeUndefined();
    expect(readChallengeToken({})).toBeUndefined();
  });
  it('detects a Bearer credential', () => {
    expect(hasBearerCredential({ authorization: 'Bearer feasly_live_x' })).toBe(true);
    expect(hasBearerCredential({ Authorization: 'bearer abc' })).toBe(true);
    expect(hasBearerCredential({ authorization: 'Bearer ' })).toBe(false);
    expect(hasBearerCredential({ authorization: 'Basic abc' })).toBe(false);
    expect(hasBearerCredential({})).toBe(false);
  });
});

describe('pipeline + bot challenge (#788)', () => {
  it('never challenges a normal user who stays under the limit', async () => {
    const verifier = verifierAccepting('good');
    const { pipeline } = gatedPipeline(verifier);
    expect(await pipeline.run({ headers: {}, clientIp: '1.1.1.1' }, ok)).toBe('ok');
    expect(await pipeline.run({ headers: {}, clientIp: '1.1.1.1' }, ok)).toBe('ok');
    expect(verifier.calls).toHaveLength(0);
  });

  it('requires a challenge from an IP after it trips the limit, with the site key', async () => {
    const { pipeline, logs } = gatedPipeline(verifierAccepting('good'));
    const req = { headers: {}, clientIp: '2.2.2.2' };
    await pipeline.run(req, ok);
    await pipeline.run(req, ok);
    const tripped = await pipeline.run(req, ok);
    expect(isProblemDetails(tripped) && tripped.code).toBe(ErrorCodes.RATE_LIMITED);

    const challenged = await pipeline.run(req, ok);
    if (!isProblemDetails(challenged)) throw new Error('expected a problem');
    expect(challenged.status).toBe(403);
    expect(challenged.code).toBe(ErrorCodes.CHALLENGE_REQUIRED);
    expect(challenged.retryable).toBe(false);
    expect(challenged.challenge).toEqual({ provider: 'turnstile', siteKey: SITE_KEY });
    // The raw IP never reaches the logs.
    expect(logs.some((l) => l.message.includes('2.2.2.2'))).toBe(false);
    expect(logs.some((l) => l.message.startsWith('bot-challenge reason=missing'))).toBe(true);
  });

  it('only challenges the IP that tripped — other users are untouched', async () => {
    const verifier = verifierAccepting('good');
    const { pipeline } = gatedPipeline(verifier, 1);
    const bot = { headers: {}, clientIp: '3.3.3.3' };
    await pipeline.run(bot, ok);
    await pipeline.run(bot, ok); // trips
    expect(await pipeline.run({ headers: {}, clientIp: '4.4.4.4' }, ok)).toBe('ok');
    expect(verifier.calls).toHaveLength(0);
  });

  it('lets a tripped IP through with a token the verifier accepts (once the window frees)', async () => {
    const verifier = verifierAccepting('good');
    // maxRequests 1 with a tiny window: trip, then the next window frees.
    let now = 0;
    const gate = createBotChallengeGate({
      trips: createInMemoryCooldown(86_400_000, () => now),
      verifier,
      siteKey: SITE_KEY,
    });
    const pipeline = createRequestPipeline({
      rateLimiter: createRateLimiter({
        windowMs: 1_000,
        maxRequests: 1,
        maxTrackedKeys: 100,
        clock: () => now,
      }),
      challenge: gate,
      logger: () => undefined,
    });
    await pipeline.run({ headers: {}, clientIp: '5.5.5.5' }, ok);
    await pipeline.run({ headers: {}, clientIp: '5.5.5.5' }, ok); // trips
    now = 5_000; // limiter window has reset; the trip mark has not
    const passed = await pipeline.run(
      { headers: { 'x-turnstile-token': 'good' }, clientIp: '5.5.5.5' },
      ok,
    );
    expect(passed).toBe('ok');
    expect(verifier.calls).toEqual([{ token: 'good', remoteIp: '5.5.5.5' }]);
  });

  it('fails closed on a rejected token, a throwing verifier, or an oversized token', async () => {
    const throwing: ChallengeVerifier = {
      verify: vi.fn(async () => {
        throw new Error('network down');
      }),
    };
    for (const [verifier, token] of [
      [verifierAccepting('good'), 'bad'],
      [throwing, 'anything'],
      [verifierAccepting('x'.repeat(3000)), 'x'.repeat(3000)],
    ] as const) {
      const { pipeline } = gatedPipeline(verifier, 1);
      const req = { headers: {}, clientIp: '6.6.6.6' };
      await pipeline.run(req, ok);
      await pipeline.run(req, ok); // trips
      const handler = vi.fn(ok);
      const result = await pipeline.run(
        { headers: { 'x-turnstile-token': token }, clientIp: '6.6.6.6' },
        handler,
      );
      if (!isProblemDetails(result)) throw new Error('expected a problem');
      expect(result.status).toBe(403);
      expect(result.code).toBe(ErrorCodes.CHALLENGE_FAILED);
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('exempts Bearer (agent-API) requests from both the check and the trip mark', async () => {
    const { pipeline } = gatedPipeline(verifierAccepting('good'), 1);
    const agent = { headers: { authorization: 'Bearer feasly_live_abc' }, clientIp: '7.7.7.7' };
    await pipeline.run(agent, ok);
    const limited = await pipeline.run(agent, ok);
    expect(isProblemDetails(limited) && limited.code).toBe(ErrorCodes.RATE_LIMITED);
    // Not marked: a browser request from the same IP is only rate limited,
    // never challenged.
    const browser = await pipeline.run({ headers: {}, clientIp: '7.7.7.7' }, ok);
    expect(isProblemDetails(browser) && browser.code).toBe(ErrorCodes.RATE_LIMITED);
  });

  it('does not mark a trip for a secondary (per-tenant) limiter denial', async () => {
    const gate = createBotChallengeGate({
      trips: createInMemoryCooldown(86_400_000),
      verifier: verifierAccepting('good'),
      siteKey: SITE_KEY,
    });
    const pipeline = createRequestPipeline({
      rateLimiter: createRateLimiter({ windowMs: 60_000, maxRequests: 100, maxTrackedKeys: 100 }),
      extraLimiters: [
        {
          limiter: createRateLimiter({ windowMs: 60_000, maxRequests: 1, maxTrackedKeys: 100 }),
          keyFor: (r) => (r.tenantKey ? `tenant:${r.tenantKey}` : undefined),
          label: 'tenant',
        },
      ],
      challenge: gate,
      logger: () => undefined,
    });
    await pipeline.run({ headers: {}, clientIp: '8.8.8.8', tenantKey: 't1' }, ok);
    await pipeline.run({ headers: {}, clientIp: '8.8.8.8', tenantKey: 't1' }, ok);
    // Same IP without the tenant: not challenged.
    expect(await pipeline.run({ headers: {}, clientIp: '8.8.8.8' }, ok)).toBe('ok');
  });

  it('a failed trip mark never turns the 429 into a 500', async () => {
    const gate = createBotChallengeGate({
      trips: {
        isActive: async () => false,
        start: async () => {
          throw new Error('store down');
        },
      },
      verifier: verifierAccepting('good'),
      siteKey: SITE_KEY,
    });
    const pipeline = createRequestPipeline({
      rateLimiter: createRateLimiter({ windowMs: 60_000, maxRequests: 1, maxTrackedKeys: 100 }),
      challenge: gate,
      logger: () => undefined,
    });
    await pipeline.run({ headers: {}, clientIp: '9.9.9.9' }, ok);
    const limited = await pipeline.run({ headers: {}, clientIp: '9.9.9.9' }, ok);
    expect(isProblemDetails(limited) && limited.status).toBe(429);
  });

  it('shares the trip mark across instances through the counter store (hashed key)', async () => {
    const rows = new Map<string, { count: number; expiresAt: Date }>();
    const store: SharedCounterStore = {
      async increment() {
        throw new Error('unused');
      },
      async read(key, now) {
        const row = rows.get(key);
        return row && row.expiresAt > now ? row.count : 0;
      },
      async set({ key, expiresAt }) {
        rows.set(key, { count: 1, expiresAt });
      },
      async deleteExpired() {
        return 0;
      },
    };
    const mk = () =>
      createBotChallengeGate({
        trips: createSharedCooldown({ store, scope: 'bot-challenge:ip', cooldownMs: 60_000 }),
        verifier: verifierAccepting('good'),
        siteKey: SITE_KEY,
      });
    const instanceA = mk();
    const instanceB = mk();
    await instanceA.markTripped('10.0.0.1');
    expect([...rows.keys()].some((k) => k.includes('10.0.0.1'))).toBe(false);
    const outcome = await instanceB.check({ key: '10.0.0.1', headers: {}, clientIp: '10.0.0.1' });
    expect(outcome).toEqual({ allowed: false, reason: 'missing' });
  });
});

describe('Turnstile verifier (#788)', () => {
  const URL_ = 'https://challenges.example/siteverify';

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('accepts only success: true and posts secret, token and IP as a form', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { success: true }));
    const verifier = createTurnstileVerifier({
      secretKey: 'test-secret',
      verifyUrl: URL_,
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: () => undefined,
    });
    expect(await verifier.verify('tok', '1.2.3.4')).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_);
    expect(init.method).toBe('POST');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('secret')).toBe('test-secret');
    expect(form.get('response')).toBe('tok');
    expect(form.get('remoteip')).toBe('1.2.3.4');
  });

  it('fails closed on rejection, non-2xx, bad JSON and network errors — and never logs the secret', async () => {
    const logs: string[] = [];
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse(200, { success: false, 'error-codes': ['invalid-input-response'] }),
      async () => jsonResponse(200, { success: 'true' }),
      async () => jsonResponse(500, { success: true }),
      async () => new Response('not json', { status: 200 }),
      async () => {
        throw new TypeError('fetch failed');
      },
    ];
    for (const impl of cases) {
      const verifier = createTurnstileVerifier({
        secretKey: 'test-secret',
        verifyUrl: URL_,
        timeoutMs: 1_000,
        fetchImpl: vi.fn(impl) as unknown as typeof fetch,
        logger: (m) => logs.push(m),
      });
      expect(await verifier.verify('tok-sentinel-7f3a', undefined)).toBe(false);
    }
    expect(logs.some((m) => m.includes('invalid-input-response'))).toBe(true);
    expect(logs.join('\n')).not.toContain('test-secret');
    expect(logs.join('\n')).not.toContain('tok-sentinel-7f3a');
  });

  it('fails closed without calling out when the secret or token is empty', async () => {
    const fetchImpl = vi.fn();
    const verifier = createTurnstileVerifier({
      secretKey: '',
      verifyUrl: URL_,
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await verifier.verify('tok', undefined)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
