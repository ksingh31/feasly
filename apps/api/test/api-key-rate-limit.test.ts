/**
 * Per-key rate limit middleware tests (api-mcp/07).
 *
 * Covers: no-Bearer passthrough, limit breach → 429 with headers,
 * per-key isolation, and no usage writes on 429s.
 */
import { describe, expect, it } from 'vitest';
import { createApiKeyRateLimitMiddleware } from '../src/middleware/api-key-rate-limit';
import { isMeteredMcpBody } from '../src/middleware/mcp-metering';
import {
  HttpError,
  ErrorCodes,
  isProblemDetails,
  problemResponseHeaders,
} from '../src/middleware/errors';
import type { ApiKeyService, ApiKeyRecord } from '../src/services/api-key.service';
import {
  createUsageService,
  type UsageStore,
} from '../src/services/usage.service';

function createKeyRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'key-1',
    name: 'Test key',
    tenantId: null,
    keyPrefix: 'feasly_live_…test',
    scopes: ['estimate'],
    rateLimitPerMin: 5,
    sandbox: false,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Fake ApiKeyService: token → record map. */
function createFakeApiKeys(records: Record<string, ApiKeyRecord>): ApiKeyService {
  return {
    async issue() {
      throw new Error('not implemented');
    },
    async rotate() {
      throw new Error('not implemented');
    },
    async revoke() {
      throw new Error('not implemented');
    },
    async list() {
      return [];
    },
    async update() {
      throw new Error('not implemented');
    },
    async authenticate(token: string) {
      const record = records[token];
      if (!record) {
        throw new HttpError(401, ErrorCodes.INVALID_API_KEY, 'Invalid API key.', false);
      }
      return record;
    },
  };
}

function createInMemoryUsageStore(): UsageStore & { rows: unknown[] } {
  const rows: {
    apiKeyId: string;
    endpoint: string;
    estimateId: string | null;
    createdAt: Date;
  }[] = [];
  return {
    rows,
    async insert(record) {
      rows.push({
        apiKeyId: record.apiKeyId,
        endpoint: record.endpoint,
        estimateId: record.estimateId,
        createdAt: record.createdAt,
      });
    },
    async countSince(apiKeyId: string, since: Date) {
      return rows.filter(
        (r) => r.apiKeyId === apiKeyId && r.createdAt > since,
      ).length;
    },
    async oldestSince(apiKeyId: string, since: Date) {
      const m = rows
        .filter((r) => r.apiKeyId === apiKeyId && r.createdAt > since)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return m[0]?.createdAt ?? null;
    },
    async aggregate() {
      return [];
    },
  };
}

/** Quotas far above anything these tests send — per-minute tests only. */
const NO_QUOTA = { daily: 1_000_000, monthly: 1_000_000 };

describe('per-key rate limit middleware (api-mcp/07)', () => {
  it('no Bearer token → passthrough, no usage recorded', async () => {
    const usageStore = createInMemoryUsageStore();
    const usage = createUsageService({ store: usageStore });
    const apiKeys = createFakeApiKeys({});
    const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage, quota: NO_QUOTA });

    let handlerRan = false;
    const result = await withLimit(
      {},
      'corr-1',
      { endpoint: '/api/v1/estimate', requiredScope: 'estimate' },
      async () => {
        handlerRan = true;
        return { ok: true };
      },
    );
    expect(handlerRan).toBe(true);
    expect(result).toEqual({ ok: true });
    expect(usageStore.rows.length).toBe(0);
  });

  it('AC1: 6th request with rate_limit=5 → 429 with RATE_LIMITED + headers', async () => {
    const usageStore = createInMemoryUsageStore();
    const usage = createUsageService({ store: usageStore });
    const keyRecord = createKeyRecord({ id: 'key-1', rateLimitPerMin: 5 });
    const apiKeys = createFakeApiKeys({ 'valid-token': keyRecord });
    const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage, quota: NO_QUOTA });
    const headers = { authorization: 'Bearer valid-token' };

    // 5 succeed
    for (let i = 0; i < 5; i++) {
      const r = await withLimit(headers, 'corr-1', { endpoint: '/api/v1/estimate', requiredScope: 'estimate' }, async () => ({ ok: true }));
      expect(isProblemDetails(r)).toBe(false);
    }
    expect(usageStore.rows.length).toBe(5);

    // 6th → 429
    const denied = await withLimit(
      headers,
      'corr-1',
      { endpoint: '/api/v1/estimate', requiredScope: 'estimate' },
      async () => ({ ok: true }),
    );
    expect(isProblemDetails(denied)).toBe(true);
    if (isProblemDetails(denied)) {
      expect(denied.status).toBe(429);
      expect(denied.code).toBe('RATE_LIMITED');
      const h = problemResponseHeaders(denied);
      expect(h['X-RateLimit-Limit']).toBe('5');
      expect(h['X-RateLimit-Remaining']).toBe('0');
      // Reset is an epoch within the current window
      const reset = Number(h['X-RateLimit-Reset']);
      const nowEpoch = Math.floor(Date.now() / 1000);
      expect(reset).toBeGreaterThanOrEqual(nowEpoch - 1);
      expect(reset).toBeLessThanOrEqual(nowEpoch + 60);
    }
    // AC4: 429 wrote no usage row
    expect(usageStore.rows.length).toBe(5);
  });

  it('AC3: two keys on one IP are independent', async () => {
    const usageStore = createInMemoryUsageStore();
    const usage = createUsageService({ store: usageStore });
    const keyA = createKeyRecord({ id: 'key-a', rateLimitPerMin: 2 });
    const keyB = createKeyRecord({ id: 'key-b', rateLimitPerMin: 2 });
    const apiKeys = createFakeApiKeys({ 'token-a': keyA, 'token-b': keyB });
    const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage, quota: NO_QUOTA });

    // Exhaust key-A
    for (let i = 0; i < 2; i++) {
      await withLimit({ authorization: 'Bearer token-a' }, 'c', { endpoint: '/e', requiredScope: 'estimate' }, async () => ({}));
    }
    const deniedA = await withLimit({ authorization: 'Bearer token-a' }, 'c', { endpoint: '/e', requiredScope: 'estimate' }, async () => ({}));
    expect(isProblemDetails(deniedA)).toBe(true);

    // key-B still fine
    const okB = await withLimit({ authorization: 'Bearer token-b' }, 'c', { endpoint: '/e', requiredScope: 'estimate' }, async () => ({ ok: 1 }));
    expect(isProblemDetails(okB)).toBe(false);
  });

  it('successful handler result passes through, usage recorded with estimateId', async () => {
    const usageStore = createInMemoryUsageStore();
    const usage = createUsageService({ store: usageStore });
    const keyRecord = createKeyRecord({ id: 'key-1', rateLimitPerMin: 100 });
    const apiKeys = createFakeApiKeys({ 'valid-token': keyRecord });
    const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage, quota: NO_QUOTA });

    const result = await withLimit(
      { authorization: 'Bearer valid-token' },
      'corr-1',
      {
        endpoint: '/api/v1/estimate',
        requiredScope: 'estimate',
        extractEstimateId: (r) => (r as { estimateId: string }).estimateId,
      },
      async () => ({ estimateId: 'est-123' }),
    );
    expect(result).toEqual({ estimateId: 'est-123' });
    expect(usageStore.rows.length).toBe(1);
    expect((usageStore.rows[0] as { estimateId: string }).estimateId).toBe('est-123');
  });

  it('invalid Bearer token → 401 thrown (no oracle)', async () => {
    const usageStore = createInMemoryUsageStore();
    const usage = createUsageService({ store: usageStore });
    const apiKeys = createFakeApiKeys({});
    const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage, quota: NO_QUOTA });

    await expect(
      withLimit(
        { authorization: 'Bearer bogus' },
        'corr-1',
        { endpoint: '/api/v1/estimate', requiredScope: 'estimate' },
        async () => ({}),
      ),
    ).rejects.toMatchObject({ status: 401, code: 'INVALID_API_KEY' });
    expect(usageStore.rows.length).toBe(0);
  });
  describe('#802: required scope', () => {
    it('key without the required scope → 403 FORBIDDEN, handler not run, no usage, no budget', async () => {
      const usageStore = createInMemoryUsageStore();
      const usage = createUsageService({ store: usageStore });
      const keyRecord = createKeyRecord({ scopes: ['property:read'] });
      const apiKeys = createFakeApiKeys({ 'read-only': keyRecord });
      const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage, quota: NO_QUOTA });

      let handlerRan = false;
      await expect(
        withLimit(
          { authorization: 'Bearer read-only' },
          'corr-1',
          { endpoint: '/api/v1/estimate', requiredScope: 'estimate' },
          async () => {
            handlerRan = true;
            return {};
          },
        ),
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(handlerRan).toBe(false);
      expect(usageStore.rows.length).toBe(0);
    });

    it('scope is checked before the rate limit (exhausted key still gets 403 for a missing scope)', async () => {
      const usageStore = createInMemoryUsageStore();
      const usage = createUsageService({ store: usageStore });
      const keyRecord = createKeyRecord({ scopes: ['property:read'], rateLimitPerMin: 1 });
      const apiKeys = createFakeApiKeys({ 'read-only': keyRecord });
      const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage, quota: NO_QUOTA });
      const headers = { authorization: 'Bearer read-only' };
      const lookup = { endpoint: '/api/v1/properties/lookup', requiredScope: 'property:read' } as const;

      await withLimit(headers, 'c', lookup, async () => ({}));
      const limited = await withLimit(headers, 'c', lookup, async () => ({}));
      expect(isProblemDetails(limited) && limited.status).toBe(429);

      await expect(
        withLimit(headers, 'c', { endpoint: '/api/v1/leads', requiredScope: 'lead' }, async () => ({})),
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    });

    it('key with the required scope among several → handler runs', async () => {
      const usageStore = createInMemoryUsageStore();
      const usage = createUsageService({ store: usageStore });
      const keyRecord = createKeyRecord({ scopes: ['property:read', 'lead'] });
      const apiKeys = createFakeApiKeys({ multi: keyRecord });
      const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage, quota: NO_QUOTA });

      const result = await withLimit(
        { authorization: 'Bearer multi' },
        'corr-1',
        { endpoint: '/api/v1/leads', requiredScope: 'lead' },
        async () => ({ ok: true }),
      );
      expect(result).toEqual({ ok: true });
      expect(usageStore.rows.length).toBe(1);
    });

    it('no Bearer key → passthrough regardless of required scope (first-party traffic)', async () => {
      const usage = createUsageService({ store: createInMemoryUsageStore() });
      const withLimit = createApiKeyRateLimitMiddleware({ apiKeys: createFakeApiKeys({}), usage, quota: NO_QUOTA });
      const result = await withLimit(
        {},
        'corr-1',
        { endpoint: '/api/v1/leads', requiredScope: 'lead' },
        async () => ({ ok: true }),
      );
      expect(result).toEqual({ ok: true });
    });
  });
});

describe('per-key daily / monthly quota (#738)', () => {
  const headers = { authorization: 'Bearer valid-token' };
  const call = (
    withLimit: ReturnType<typeof createApiKeyRateLimitMiddleware>,
    h: Record<string, string> = headers,
  ) => withLimit(h, 'corr-q', { endpoint: '/api/v1/estimate', requiredScope: 'estimate' }, async () => ({ ok: true }));

  it('AC2: the call past the daily quota → 429 QUOTA_EXCEEDED with Retry-After and quota headers, no usage row', async () => {
    const usageStore = createInMemoryUsageStore();
    const usage = createUsageService({ store: usageStore });
    const apiKeys = createFakeApiKeys({ 'valid-token': createKeyRecord({ rateLimitPerMin: 100 }) });
    const withLimit = createApiKeyRateLimitMiddleware({
      apiKeys,
      usage,
      quota: { daily: 3, monthly: 2_000 },
    });

    for (let i = 0; i < 3; i++) {
      expect(isProblemDetails(await call(withLimit))).toBe(false);
    }
    const denied = await call(withLimit);
    expect(isProblemDetails(denied)).toBe(true);
    if (!isProblemDetails(denied)) return;
    expect(denied.status).toBe(429);
    expect(denied.code).toBe(ErrorCodes.QUOTA_EXCEEDED);
    expect(denied.message).toMatch(/daily request quota/);
    const h = problemResponseHeaders(denied);
    const now = new Date();
    const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000;
    expect(h['X-Quota-Period']).toBe('day');
    expect(h['X-Quota-Limit']).toBe('3');
    expect(h['X-Quota-Remaining']).toBe('0');
    expect(Number(h['X-Quota-Reset'])).toBe(nextMidnight);
    const retryAfter = Number(h['Retry-After']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
    expect(Math.abs(retryAfter - (nextMidnight - Date.now() / 1000))).toBeLessThanOrEqual(2);
    // The rejected call consumed nothing.
    expect(usageStore.rows.length).toBe(3);
  });

  it('AC2: the quota holds across two instances sharing the usage table', async () => {
    // Two Function App instances = two middleware + service stacks over
    // the same api_usage table (here one shared store).
    const sharedStore = createInMemoryUsageStore();
    const apiKeys = createFakeApiKeys({ 'valid-token': createKeyRecord({ rateLimitPerMin: 100 }) });
    const quota = { daily: 4, monthly: 2_000 };
    const instanceA = createApiKeyRateLimitMiddleware({
      apiKeys,
      usage: createUsageService({ store: sharedStore }),
      quota,
    });
    const instanceB = createApiKeyRateLimitMiddleware({
      apiKeys,
      usage: createUsageService({ store: sharedStore }),
      quota,
    });

    const results = [];
    for (let i = 0; i < 8; i++) {
      results.push(await call(i % 2 === 0 ? instanceA : instanceB));
    }
    const accepted = results.filter((r) => !isProblemDetails(r));
    const denied = results.filter((r) => isProblemDetails(r));
    expect(accepted).toHaveLength(4);
    expect(denied).toHaveLength(4);
    for (const d of denied) {
      expect(isProblemDetails(d) && d.code).toBe(ErrorCodes.QUOTA_EXCEEDED);
    }
    expect(sharedStore.rows.length).toBe(4);
  });

  it('quotas are per key: one exhausted key does not block another', async () => {
    const usageStore = createInMemoryUsageStore();
    const usage = createUsageService({ store: usageStore });
    const apiKeys = createFakeApiKeys({
      'token-a': createKeyRecord({ id: 'key-a', rateLimitPerMin: 100 }),
      'token-b': createKeyRecord({ id: 'key-b', rateLimitPerMin: 100 }),
    });
    const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage, quota: { daily: 1, monthly: 10 } });
    expect(isProblemDetails(await call(withLimit, { authorization: 'Bearer token-a' }))).toBe(false);
    expect(isProblemDetails(await call(withLimit, { authorization: 'Bearer token-a' }))).toBe(true);
    expect(isProblemDetails(await call(withLimit, { authorization: 'Bearer token-b' }))).toBe(false);
  });

  it('first-party traffic without a Bearer key is never quota-checked', async () => {
    const usageStore = createInMemoryUsageStore();
    const usage = createUsageService({ store: usageStore });
    const withLimit = createApiKeyRateLimitMiddleware({
      apiKeys: createFakeApiKeys({}),
      usage,
      quota: { daily: 1, monthly: 1 },
    });
    for (let i = 0; i < 3; i++) {
      expect(isProblemDetails(await call(withLimit, {}))).toBe(false);
    }
  });
});

describe('unmetered calls and route-gated scopes (#738 review)', () => {
  it('metered: false → handler runs, no quota check, no usage row (even at quota)', async () => {
    const usageStore = createInMemoryUsageStore();
    const usage = createUsageService({ store: usageStore });
    const apiKeys = createFakeApiKeys({ 'valid-token': createKeyRecord({ rateLimitPerMin: 100 }) });
    const withLimit = createApiKeyRateLimitMiddleware({
      apiKeys,
      usage,
      quota: { daily: 1, monthly: 1 },
    });
    const headers = { authorization: 'Bearer valid-token' };
    const metered = { endpoint: '/api/mcp/v1', requiredScope: null, metered: true } as const;
    const housekeeping = { endpoint: '/api/mcp/v1', requiredScope: null, metered: false } as const;

    expect(isProblemDetails(await withLimit(headers, 'c', metered, async () => ({})))).toBe(false);
    expect(usageStore.rows.length).toBe(1);
    // Quota now exhausted — housekeeping still goes through, unrecorded.
    for (let i = 0; i < 3; i++) {
      expect(await withLimit(headers, 'c', housekeeping, async () => ({ ok: true }))).toEqual({ ok: true });
    }
    expect(usageStore.rows.length).toBe(1);
    const denied = await withLimit(headers, 'c', metered, async () => ({}));
    expect(isProblemDetails(denied) && denied.code).toBe(ErrorCodes.QUOTA_EXCEEDED);
  });

  it('requiredScope: null skips the middleware scope gate (the route checks per operation)', async () => {
    const usage = createUsageService({ store: createInMemoryUsageStore() });
    const apiKeys = createFakeApiKeys({ ro: createKeyRecord({ scopes: ['property:read'] }) });
    const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage, quota: NO_QUOTA });
    const result = await withLimit(
      { authorization: 'Bearer ro' },
      'c',
      { endpoint: '/api/mcp/v1', requiredScope: null },
      async () => ({ ok: true }),
    );
    expect(result).toEqual({ ok: true });
  });
});

describe('isMeteredMcpBody (#738 review)', () => {
  it('meters tools/call, single or in a batch, parsed or raw', () => {
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estimate' } };
    expect(isMeteredMcpBody(call)).toBe(true);
    expect(isMeteredMcpBody(JSON.stringify(call))).toBe(true);
    expect(isMeteredMcpBody([{ jsonrpc: '2.0', method: 'notifications/initialized' }, call])).toBe(true);
  });

  it('does not meter protocol housekeeping', () => {
    for (const method of ['initialize', 'tools/list', 'notifications/initialized', 'ping']) {
      expect(isMeteredMcpBody({ jsonrpc: '2.0', id: 1, method })).toBe(false);
    }
    expect(isMeteredMcpBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toBe(false);
  });

  it('meters anything unrecognisable (cautious default)', () => {
    expect(isMeteredMcpBody('not json')).toBe(true);
    expect(isMeteredMcpBody([])).toBe(true);
    expect(isMeteredMcpBody(null)).toBe(true);
    expect(isMeteredMcpBody(42)).toBe(true);
  });
});
