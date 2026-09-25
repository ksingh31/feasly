/**
 * Interim admin guard tests (api-mcp/01).
 *
 * The guard is fail-closed: without ADMIN_API_KEY configured, or with a
 * wrong key presented, admin endpoints 401. admin/01 replaces this with
 * session auth.
 */
import { describe, expect, it } from 'vitest';
import { createConfigAdminGuard } from '../src/middleware/admin-guard';
import type { HttpError } from '../src/middleware/errors';

function rejected(
  guard: ReturnType<typeof createConfigAdminGuard>,
  headers: Record<string, string | string[] | undefined>,
): HttpError | null {
  try {
    guard.requireAdmin(headers);
    return null;
  } catch (e) {
    return e as HttpError;
  }
}

describe('interim admin guard (api-mcp/01)', () => {
  it('correct key passes', () => {
    const guard = createConfigAdminGuard({ adminApiKey: 's3cr3t' });
    expect(() => guard.requireAdmin({ 'x-admin-key': 's3cr3t' })).not.toThrow();
  });

  it('wrong key → 401', () => {
    const guard = createConfigAdminGuard({ adminApiKey: 's3cr3t' });
    const error = rejected(guard, { 'x-admin-key': 'wrong' });
    expect(error?.status).toBe(401);
    expect(error?.code).toBe('UNAUTHENTICATED');
  });

  it('missing header → 401', () => {
    const guard = createConfigAdminGuard({ adminApiKey: 's3cr3t' });
    const error = rejected(guard, {});
    expect(error?.status).toBe(401);
  });

  it('unset ADMIN_API_KEY → fail closed even with a presented key', () => {
    const guard = createConfigAdminGuard({ adminApiKey: undefined });
    const error = rejected(guard, { 'x-admin-key': 'anything' });
    expect(error?.status).toBe(401);
  });
});
