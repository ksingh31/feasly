/**
 * Usage route tests (api-mcp/07).
 *
 * Covers: admin sees all keys, key owner sees only own key, owner
 * querying another key → 403, no auth → 401, bad date → 400.
 * The UsageService is faked; the AdminGuard uses the real
 * createSessionAdminGuard with a fake AdminAuthService.
 */
import { describe, expect, it } from 'vitest';
import { createUsageRoute } from '../src/routes/usage.route';
import {
  ADMIN_SESSION_COOKIE,
  createSessionAdminGuard,
} from '../src/middleware/admin-guard';
import { HttpError, ErrorCodes } from '../src/middleware/errors';
import type { ApiKeyService } from '../src/services/api-key.service';
import type {
  UsageAggregate,
  UsageService,
} from '../src/services/usage.service';

const SESSION_TOKEN = 'test-session-token';
const adminHeaders = {
  cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(SESSION_TOKEN)}`,
};

function fakeAdminAuth(validToken: string | null) {
  return {
    validateSession: async (token: string | null) =>
      token !== null && token === validToken ? 'admin@example.com' : null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionGuard = (validToken: string | null = SESSION_TOKEN) =>
  createSessionAdminGuard({ adminAuth: fakeAdminAuth(validToken) as any });

function createFakeUsage(aggregates: UsageAggregate[]): UsageService & {
  lastQuery: unknown;
  lastScope: unknown;
} {
  const fake = {
    lastQuery: null as unknown,
    lastScope: null as unknown,
    async recordUsage() {},
    async checkRateLimit() {
      return { allowed: true, limit: 100, remaining: 99, resetEpoch: 0 };
    },
    async getUsage(query: unknown, scope: unknown) {
      fake.lastQuery = query;
      fake.lastScope = scope;
      // Simulate owner-scope filtering like the real service.
      if ((scope as { kind: string }).kind === 'owner') {
        const ownerId = (scope as { apiKeyId: string }).apiKeyId;
        const q = query as { apiKeyId?: string };
        if (q.apiKeyId && q.apiKeyId !== ownerId) {
          throw new HttpError(403, ErrorCodes.FORBIDDEN, 'Cannot query usage for another API key.', false);
        }
        return aggregates.filter((a) =>
          // Fake aggregates carry the key id in a test-only field.
          (a as unknown as { keyId: string }).keyId === ownerId,
        );
      }
      return aggregates;
    },
  };
  return fake;
}

function createFakeApiKeys(ownerId: string): ApiKeyService {
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
    async authenticate(token: string) {
      if (token === 'owner-token') {
        return {
          id: ownerId,
          name: 'Owner key',
          tenantId: null,
          keyPrefix: 'feasly_live_…own',
          scopes: ['estimate'],
          rateLimitPerMin: 100,
          sandbox: false,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
        };
      }
      throw new HttpError(401, ErrorCodes.INVALID_API_KEY, 'Invalid API key.', false);
    },
  };
}

const AGG: UsageAggregate[] = [
  {
    date: '2026-09-25',
    endpoint: '/api/v1/estimate',
    count: 10,
    estimatesCreated: 4,
  } as UsageAggregate & { keyId: string },
].map((a) => ({ ...a, keyId: 'owner-key-id' }) as unknown as UsageAggregate);

describe('usage route (api-mcp/07)', () => {
  it('admin (X-Admin-Key) sees aggregates', async () => {
    const usage = createFakeUsage(AGG);
    const route = createUsageRoute({
      usage,
      apiKeys: createFakeApiKeys('owner-key-id'),
      adminGuard: sessionGuard(),
    });
    const result = await route.getUsage(adminHeaders, {});
    expect(result).toEqual([
      {
        date: '2026-09-25',
        endpoint: '/api/v1/estimate',
        count: 10,
        estimates_created: 4,
      },
    ]);
    expect(usage.lastScope).toEqual({ kind: 'admin' });
  });

  it('key owner (Bearer) sees only own aggregates', async () => {
    const usage = createFakeUsage(AGG);
    const route = createUsageRoute({
      usage,
      apiKeys: createFakeApiKeys('owner-key-id'),
      adminGuard: sessionGuard(),
    });
    const result = await route.getUsage(
      { authorization: 'Bearer owner-token' },
      {},
    );
    expect(result.length).toBe(1);
    expect(usage.lastScope).toEqual({
      kind: 'owner',
      apiKeyId: 'owner-key-id',
    });
  });

  it('owner querying another key_id → 403', async () => {
    const usage = createFakeUsage(AGG);
    const route = createUsageRoute({
      usage,
      apiKeys: createFakeApiKeys('owner-key-id'),
      adminGuard: sessionGuard(),
    });
    await expect(
      route.getUsage(
        { authorization: 'Bearer owner-token' },
        { key_id: 'some-other-key' },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('no auth → 401', async () => {
    const usage = createFakeUsage(AGG);
    const route = createUsageRoute({
      usage,
      apiKeys: createFakeApiKeys('owner-key-id'),
      adminGuard: sessionGuard(),
    });
    await expect(route.getUsage({}, {})).rejects.toMatchObject({
      status: 401,
    });
  });

  it('invalid from date → 400', async () => {
    const usage = createFakeUsage(AGG);
    const route = createUsageRoute({
      usage,
      apiKeys: createFakeApiKeys('owner-key-id'),
      adminGuard: sessionGuard(),
    });
    await expect(
      route.getUsage(adminHeaders, { from: 'not-a-date' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('from after to → 400', async () => {
    const usage = createFakeUsage(AGG);
    const route = createUsageRoute({
      usage,
      apiKeys: createFakeApiKeys('owner-key-id'),
      adminGuard: sessionGuard(),
    });
    await expect(
      route.getUsage(
        adminHeaders,
        { from: '2026-09-26', to: '2026-09-25' },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
