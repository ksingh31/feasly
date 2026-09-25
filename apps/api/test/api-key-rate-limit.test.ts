/**
 * Per-key rate limit middleware tests (api-mcp/07).
 *
 * Covers: no-Bearer passthrough, limit breach → 429 with headers,
 * per-key isolation, and no usage writes on 429s.
 */
import { describe, expect, it } from 'vitest';
import { createApiKeyRateLimitMiddleware } from '../src/middleware/api-key-rate-limit';
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

describe('per-key rate limit middleware (api-mcp/07)', () => {
  it('no Bearer token → passthrough, no usage recorded', async () => {
    const usageStore = createInMemoryUsageStore();
    const usage = createUsageService({ store: usageStore });
    const apiKeys = createFakeApiKeys({});
    const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage });

    let handlerRan = false;
    const result = await withLimit(
      {},
      'corr-1',
      { endpoint: '/api/v1/estimate' },
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
    const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage });
    const headers = { authorization: 'Bearer valid-token' };

    // 5 succeed
    for (let i = 0; i < 5; i++) {
      const r = await withLimit(headers, 'corr-1', { endpoint: '/api/v1/estimate' }, async () => ({ ok: true }));
      expect(isProblemDetails(r)).toBe(false);
    }
    expect(usageStore.rows.length).toBe(5);

    // 6th → 429
    const denied = await withLimit(
      headers,
      'corr-1',
      { endpoint: '/api/v1/estimate' },
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
    const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage });

    // Exhaust key-A
    for (let i = 0; i < 2; i++) {
      await withLimit({ authorization: 'Bearer token-a' }, 'c', { endpoint: '/e' }, async () => ({}));
    }
    const deniedA = await withLimit({ authorization: 'Bearer token-a' }, 'c', { endpoint: '/e' }, async () => ({}));
    expect(isProblemDetails(deniedA)).toBe(true);

    // key-B still fine
    const okB = await withLimit({ authorization: 'Bearer token-b' }, 'c', { endpoint: '/e' }, async () => ({ ok: 1 }));
    expect(isProblemDetails(okB)).toBe(false);
  });

  it('successful handler result passes through, usage recorded with estimateId', async () => {
    const usageStore = createInMemoryUsageStore();
    const usage = createUsageService({ store: usageStore });
    const keyRecord = createKeyRecord({ id: 'key-1', rateLimitPerMin: 100 });
    const apiKeys = createFakeApiKeys({ 'valid-token': keyRecord });
    const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage });

    const result = await withLimit(
      { authorization: 'Bearer valid-token' },
      'corr-1',
      {
        endpoint: '/api/v1/estimate',
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
    const withLimit = createApiKeyRateLimitMiddleware({ apiKeys, usage });

    await expect(
      withLimit(
        { authorization: 'Bearer bogus' },
        'corr-1',
        { endpoint: '/api/v1/estimate' },
        async () => ({}),
      ),
    ).rejects.toMatchObject({ status: 401, code: 'INVALID_API_KEY' });
    expect(usageStore.rows.length).toBe(0);
  });
});
