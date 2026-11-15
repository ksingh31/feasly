/**
 * Admin global search route + contract (⌘K palette).
 *
 * The route is thin: permission guard → query validation → one service
 * call → contract shape. 401/403 come from the real PermissionGuard so
 * the role semantics are the production ones (builder roles hold no
 * `leads:read` → 403). The registry role matrix lives in
 * route-registry.conformance.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AdminSearchHit, AdminSearchResponse } from '@feasly/contracts';
import { createAdminSearchRoute } from '../src/routes/admin-search.route';
import type { AdminSearchService } from '../src/services/admin-search.service';
import { createPermissionGuard } from '../src/middleware/permission-guard';
import { HttpError } from '../src/middleware/errors';
import { adminSessionRateLimitKey } from '../src/middleware/admin-guard';
import { effectivePermissions } from '../src/auth/permissions';
import type { AuthContext, AuthContextService } from '../src/services/auth-context.service';
import type { BuilderRole, StaffRole } from '../src/services/user.service';
import { ROUTE_REGISTRY } from '../src/registry/route-registry';

const HEADERS = { cookie: 'feasly_admin_session=valid-test-session' };

function ctxFor(staff: StaffRole | null, members: BuilderRole[] = []): AuthContext {
  return {
    userId: 'u-1',
    email: 'someone@example.com',
    name: 'Someone',
    staffRole: staff,
    permissions: effectivePermissions(staff, members),
    builderId: members.length ? 'b-1' : null,
    builderName: null,
    memberships: members.map((role) => ({ builderId: 'b-1', role })),
    viewAs: null,
    realUser: null,
  } as unknown as AuthContext;
}

const SAMPLE_HITS: AdminSearchHit[] = [
  { kind: 'lead', id: '11111111-1111-4111-8111-111111111111', label: 'Ava', sublabel: 'ava@example.com' },
  { kind: 'invoice', id: '22222222-2222-4222-8222-222222222222', label: 'FEAS-2026-0105', sublabel: 'elite-craft · paid' },
  { kind: 'builder', id: '33333333-3333-4333-8333-333333333333', label: 'Elite Craft', sublabel: 'elite-craft' },
  { kind: 'user', id: '44444444-4444-4444-8444-444444444444', label: 'Morgan', sublabel: 'morgan@feasly.test' },
];

function setup(ctx: AuthContext | null) {
  const authContext = {
    resolve: vi.fn().mockResolvedValue(ctx),
    auditDenied: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthContextService;
  const permissionGuard = createPermissionGuard({ authContext });
  const search = {
    search: vi.fn().mockResolvedValue(SAMPLE_HITS),
  } as unknown as AdminSearchService & { search: ReturnType<typeof vi.fn> };
  const route = createAdminSearchRoute({ search, permissionGuard });
  return { route, search, authContext };
}

async function expectHttpError(p: Promise<unknown>, status: number): Promise<HttpError> {
  const err = await p.then(
    () => {
      throw new Error(`expected HTTP ${status}`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
  return err as HttpError;
}

describe('GET /api/v1/admin/search — authorization', () => {
  it('401s without a session and never calls the service', async () => {
    const { route, search } = setup(null);
    await expectHttpError(route.search({}, { q: 'ava' }), 401);
    expect(search.search).not.toHaveBeenCalled();
  });

  it.each([
    ['builder_admin', ctxFor(null, ['builder_admin'])],
    ['builder_member', ctxFor(null, ['builder_member'])],
    ['no role', ctxFor(null)],
  ])('403s for a non-admin (%s), audit-logged, no data', async (_label, ctx) => {
    const { route, search, authContext } = setup(ctx);
    const err = await expectHttpError(route.search(HEADERS, { q: 'ava' }), 403);
    expect(JSON.stringify(err)).not.toContain('Ava');
    expect(search.search).not.toHaveBeenCalled();
    expect(authContext.auditDenied).toHaveBeenCalledWith(
      expect.objectContaining({ permission: 'leads:read', route: 'GET /api/v1/admin/search' }),
    );
  });

  it.each(['super_admin', 'admin', 'viewer'] as const)(
    'allows staff role %s and passes its permissions to the service',
    async (role) => {
      const ctx = ctxFor(role);
      const { route, search } = setup(ctx);
      await route.search(HEADERS, { q: 'ava' });
      expect(search.search).toHaveBeenCalledWith('ava', ctx.permissions);
    },
  );

  it('authorizes before validating (a builder with a bad query still gets 403)', async () => {
    const { route } = setup(ctxFor(null, ['builder_admin']));
    await expectHttpError(route.search(HEADERS, {}), 403);
  });
});

describe('GET /api/v1/admin/search — validation + contract', () => {
  it.each([
    ['missing', {}],
    ['empty', { q: '' }],
    ['whitespace only', { q: '   ' }],
    ['too long', { q: 'x'.repeat(101) }],
    ['non-string', { q: 42 }],
  ])('400s when q is %s', async (_label, query) => {
    const { route, search } = setup(ctxFor('admin'));
    await expectHttpError(route.search(HEADERS, query), 400);
    expect(search.search).not.toHaveBeenCalled();
  });

  it('trims q, takes the first value of a repeated param, and returns the contract shape', async () => {
    const { route, search } = setup(ctxFor('admin'));
    const res: AdminSearchResponse = await route.search(HEADERS, { q: ['  FEAS-2026 ', 'other'] });
    expect(search.search).toHaveBeenCalledWith('FEAS-2026', expect.any(Array));
    expect(res).toEqual({ query: 'FEAS-2026', hits: SAMPLE_HITS });
    for (const hit of res.hits) {
      expect(Object.keys(hit).sort()).toEqual(['id', 'kind', 'label', 'sublabel']);
      expect(['lead', 'invoice', 'builder', 'user']).toContain(hit.kind);
    }
  });

  it('is registered admin-only, rate-limited, live', () => {
    const entry = ROUTE_REGISTRY.find(
      (e) => e.method === 'GET' && e.path === '/api/v1/admin/search',
    );
    expect(entry).toMatchObject({ auth: 'admin', permissions: ['leads:read'], status: 'live' });
    expect(entry?.rateLimit).toMatch(/per session/);
  });
});

describe('adminSessionRateLimitKey', () => {
  it('keys on a hash of the session token, never the raw token', () => {
    const key = adminSessionRateLimitKey({ headers: HEADERS, clientIp: '1.2.3.4' });
    expect(key).toMatch(/^session:[0-9a-f]{64}$/);
    expect(key).not.toContain('valid-test-session');
  });

  it('gives the same key for the same session across IPs, different keys per session', () => {
    const a = adminSessionRateLimitKey({ headers: HEADERS, clientIp: '1.1.1.1' });
    const b = adminSessionRateLimitKey({ headers: HEADERS, clientIp: '2.2.2.2' });
    const c = adminSessionRateLimitKey({
      headers: { cookie: 'feasly_admin_session=another' },
      clientIp: '1.1.1.1',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('prefers the Bearer token over the cookie (same as the guard)', () => {
    const bearer = adminSessionRateLimitKey({
      headers: { authorization: 'Bearer tok-1', cookie: 'feasly_admin_session=tok-2' },
      clientIp: undefined,
    });
    const bearerOnly = adminSessionRateLimitKey({
      headers: { authorization: 'Bearer tok-1' },
      clientIp: undefined,
    });
    expect(bearer).toBe(bearerOnly);
  });

  it('falls back to the client IP without a session', () => {
    expect(adminSessionRateLimitKey({ headers: {}, clientIp: '9.9.9.9' })).toBe('ip:9.9.9.9');
    expect(adminSessionRateLimitKey({ headers: {}, clientIp: undefined })).toBe('ip:unknown');
  });
});
