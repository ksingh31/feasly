/**
 * API key auth middleware tests (api-mcp/01).
 *
 * Verifies the middleware layer: Bearer parsing → service.authenticate →
 * auth context, and the scope gate. Failures are uniform
 * 401 INVALID_API_KEY (no oracle between unknown/revoked/malformed).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  authenticateApiKey,
  requireScope,
} from '../src/middleware/api-key-auth';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { ApiKeyService } from '../src/services/api-key.service';

function makeService(
  record: Parameters<ApiKeyService['authenticate']> extends never
    ? never
    : Awaited<ReturnType<ApiKeyService['authenticate']>> | null,
) {
  const authenticate = vi.fn();
  if (record) {
    authenticate.mockResolvedValue(record);
  } else {
    authenticate.mockRejectedValue(
      new HttpError(401, ErrorCodes.INVALID_API_KEY, 'Invalid API key.', false),
    );
  }
  return { authenticate } as unknown as ApiKeyService;
}

const RECORD = {
  id: 'key_1',
  name: 'Partner A',
  tenantId: 'tenant_1',
  keyPrefix: 'feasly_live_…abcd',
  scopes: ['property:read', 'estimate'],
  rateLimitPerMin: 100,
  sandbox: false,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: new Date('2026-09-25T00:00:00Z'),
};

describe('api-key auth middleware (api-mcp/01)', () => {
  it('parses Bearer and returns the auth context', async () => {
    const service = makeService(RECORD);

    const auth = await authenticateApiKey(
      { authorization: 'Bearer feasly_live_ABC' },
      service,
    );

    expect(service.authenticate).toHaveBeenCalledWith('feasly_live_ABC');
    expect(auth).toEqual({
      keyId: 'key_1',
      scopes: ['property:read', 'estimate'],
      sandbox: false,
      tenantId: 'tenant_1',
    });
  });

  it('missing Authorization → 401 INVALID_API_KEY', async () => {
    const service = makeService(RECORD);
    const error = await authenticateApiKey({}, service).catch((e) => e);
    expect(error.status).toBe(401);
    expect(error.code).toBe(ErrorCodes.INVALID_API_KEY);
    expect(service.authenticate).not.toHaveBeenCalled();
  });

  it('non-Bearer scheme → 401 INVALID_API_KEY', async () => {
    const service = makeService(RECORD);
    const error = await authenticateApiKey(
      { authorization: 'Basic abc' },
      service,
    ).catch((e) => e);
    expect(error.status).toBe(401);
    expect(error.code).toBe(ErrorCodes.INVALID_API_KEY);
  });

  it('unknown key → uniform 401 INVALID_API_KEY', async () => {
    const service = makeService(null);
    const error = await authenticateApiKey(
      { authorization: 'Bearer feasly_live_NOPE' },
      service,
    ).catch((e) => e);
    expect(error.status).toBe(401);
    expect(error.code).toBe(ErrorCodes.INVALID_API_KEY);
  });

  it('sandbox flag flows through the auth context', async () => {
    const service = makeService({ ...RECORD, sandbox: true });
    const auth = await authenticateApiKey(
      { authorization: 'Bearer feasly_test_ABC' },
      service,
    );
    expect(auth.sandbox).toBe(true);
  });

  it('requireScope: present scope passes', () => {
    const auth = {
      keyId: 'k',
      scopes: ['estimate'],
      sandbox: false,
      tenantId: null,
      rateLimitPerMin: 100,
    };
    expect(() => requireScope(auth, 'estimate')).not.toThrow();
  });

  it('requireScope: missing scope → 403 FORBIDDEN', () => {
    const auth = {
      keyId: 'k',
      scopes: ['property:read'],
      sandbox: false,
      tenantId: null,
      rateLimitPerMin: 100,
    };
    const error = (() => {
      try {
        requireScope(auth, 'lead');
        return null;
      } catch (e) {
        return e as HttpError;
      }
    })();
    expect(error).not.toBeNull();
    expect(error!.status).toBe(403);
    expect(error!.code).toBe(ErrorCodes.FORBIDDEN);
  });
});
