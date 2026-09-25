/**
 * API key admin route tests (api-mcp/01).
 *
 * The route is thin: admin guard → one service method → response shape.
 * Real authorization logic lives in the service (covered by
 * api-key.service.test.ts); the interim pre-shared-key guard is covered
 * here and in admin-guard.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createApiKeyRoute,
  type ApiKeyRouteDeps,
} from '../src/routes/api-key.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { ApiKeyRecord } from '../src/services/api-key.service';

const ADMIN_HEADERS = { cookie: 'feasly_admin_session=valid-test-session' };

function makeRecord(partial?: Partial<ApiKeyRecord>): ApiKeyRecord {
  return {
    id: 'key_1',
    name: 'Partner A',
    tenantId: null,
    keyPrefix: 'feasly_live_…abcd',
    scopes: ['property:read', 'estimate', 'lead'],
    rateLimitPerMin: 100,
    sandbox: false,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date('2026-09-25T00:00:00Z'),
    ...partial,
  };
}

function makeDeps(
  overrides?: Partial<{
    issueResult: { key: ApiKeyRecord; plaintext: string };
    rotateResult: { key: ApiKeyRecord; plaintext: string };
  }>,
): ApiKeyRouteDeps {
  const record = makeRecord();
  const issued = overrides?.issueResult ?? {
    key: record,
    plaintext: 'feasly_live_TESTTESTTESTTESTTESTTESTTESTTEST',
  };
  const rotated = overrides?.rotateResult ?? {
    key: makeRecord({ id: 'key_2' }),
    plaintext: 'feasly_live_ROTATEROTATEROTATEROTATEROTATE',
  };
  return {
    apiKeys: {
      issue: vi.fn().mockResolvedValue(issued),
      rotate: vi.fn().mockResolvedValue(rotated),
      revoke: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([record]),
      authenticate: vi.fn(),
    },
    adminGuard: {
      async requireAdmin(
        headers: Record<string, string | string[] | undefined>,
      ) {
        // Session-cookie mock: the test sets a valid cookie for admin.
        const cookie = headers['cookie'];
        const value = Array.isArray(cookie) ? cookie[0] : cookie;
        if (value !== 'feasly_admin_session=valid-test-session') {
          throw new HttpError(
            401,
            ErrorCodes.UNAUTHENTICATED,
            'Admin authentication required.',
            false,
          );
        }
      },
    },
  };
}

describe('api-key admin route (api-mcp/01)', () => {
  it('issue: admin passes → service called → plaintext in response', async () => {
    const route = createApiKeyRoute(makeDeps());
    const result = await route.issue(ADMIN_HEADERS, { name: 'A' });

    expect(result.plaintext).toMatch(/^feasly_live_/);
    expect(result.key.id).toBe('key_1');
    expect(result.key.key_prefix).toMatch(/…/);
    expect(result.key.created_at).toBe('2026-09-25T00:00:00.000Z');
  });

  it('issue: non-admin → 401 before the service runs', async () => {
    const deps = makeDeps();
    const route = createApiKeyRoute(deps);

    const error = await route
      .issue({ cookie: 'feasly_admin_session=wrong' }, { name: 'A' })
      .catch((e) => e);

    expect(error.status).toBe(401);
    expect(error.code).toBe(ErrorCodes.UNAUTHENTICATED);
    expect(deps.apiKeys.issue).not.toHaveBeenCalled();
  });

  it('rotate: passes the id to the service and returns the new plaintext', async () => {
    const deps = makeDeps();
    const route = createApiKeyRoute(deps);

    const result = await route.rotate(ADMIN_HEADERS, 'key_1');

    expect(deps.apiKeys.rotate).toHaveBeenCalledWith('key_1');
    expect(result.plaintext).toMatch(/^feasly_live_/);
    expect(result.key.id).toBe('key_2');
  });

  it('rotate: non-admin → 401', async () => {
    const route = createApiKeyRoute(makeDeps());
    const error = await route.rotate({}, 'key_1').catch((e) => e);
    expect(error.status).toBe(401);
  });

  it('revoke: returns a simple ack', async () => {
    const deps = makeDeps();
    const route = createApiKeyRoute(deps);

    const result = await route.revoke(ADMIN_HEADERS, 'key_1');

    expect(result).toEqual({ revoked: true });
    expect(deps.apiKeys.revoke).toHaveBeenCalledWith('key_1');
  });

  it('revoke: invalid id → 400', async () => {
    const route = createApiKeyRoute(makeDeps());
    const error = await route.revoke(ADMIN_HEADERS, '').catch((e) => e);
    expect(error.status).toBe(400);
  });

  it('list: returns masked records only', async () => {
    const route = createApiKeyRoute(makeDeps());
    const result = await route.list(ADMIN_HEADERS);

    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]!.key_prefix).toBe('feasly_live_…abcd');
    expect('plaintext' in result.keys[0]!).toBe(false);
  });
});
