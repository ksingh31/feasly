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
import {
  adminOrBuilderSessionRateLimitKey,
  adminSessionRateLimitKey,
  createAdminSearchPipeline,
} from '../src/middleware/admin-guard';
import { createRateLimiter } from '../src/middleware/rate-limit';
import { isProblemDetails } from '../src/middleware/errors';
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
    const key = adminSessionRateLimitKey({ headers: HEADERS });
    expect(key).toMatch(/^session:[0-9a-f]{64}$/);
    expect(key).not.toContain('valid-test-session');
  });

  it('gives the same key for the same session, different keys per session', () => {
    const a = adminSessionRateLimitKey({ headers: HEADERS });
    const c = adminSessionRateLimitKey({
      headers: { cookie: 'feasly_admin_session=another' },
    });
    expect(a).not.toBe(c);
  });

  it('prefers the Bearer token over the cookie (same as the guard)', () => {
    const bearer = adminSessionRateLimitKey({
      headers: { authorization: 'Bearer tok-1', cookie: 'feasly_admin_session=tok-2' },
    });
    const bearerOnly = adminSessionRateLimitKey({
      headers: { authorization: 'Bearer tok-1' },
    });
    expect(bearer).toBe(bearerOnly);
  });

  it('returns undefined without a session (the per-IP limiter covers it)', () => {
    expect(adminSessionRateLimitKey({ headers: {} })).toBeUndefined();
  });
});

describe('adminOrBuilderSessionRateLimitKey (finance exports, #728)', () => {
  it('keys a cookie-only builder session per session', () => {
    const a = adminOrBuilderSessionRateLimitKey({
      headers: { cookie: 'feasly_builder_session=b-1' },
    });
    const b = adminOrBuilderSessionRateLimitKey({
      headers: { cookie: 'feasly_builder_session=b-2' },
    });
    expect(a).toMatch(/^session:[0-9a-f]{64}$/);
    expect(a).not.toContain('b-1');
    expect(a).not.toBe(b);
    // The admin-only key gives a builder cookie no session bucket.
    expect(adminSessionRateLimitKey({ headers: { cookie: 'feasly_builder_session=b-1' } })).toBeUndefined();
  });

  it('matches the admin key for Bearer and admin-cookie sessions', () => {
    for (const headers of [
      { authorization: 'Bearer tok-1' },
      { cookie: 'feasly_admin_session=tok-2' },
    ]) {
      expect(adminOrBuilderSessionRateLimitKey({ headers })).toBe(
        adminSessionRateLimitKey({ headers }),
      );
    }
    expect(adminOrBuilderSessionRateLimitKey({ headers: {} })).toBeUndefined();
  });
});

describe('createAdminSearchPipeline — limiter order', () => {
  function pipelineWith(ipMax: number, sessionMax: number) {
    const handler = vi.fn().mockResolvedValue('ok');
    const pipeline = createAdminSearchPipeline({
      ipLimiter: createRateLimiter({ windowMs: 60_000, maxRequests: ipMax, maxTrackedKeys: 1000 }),
      sessionLimiter: createRateLimiter({
        windowMs: 60_000,
        maxRequests: sessionMax,
        maxTrackedKeys: 1000,
      }),
      logger: () => undefined,
    });
    return { pipeline, handler };
  }

  it('throttles one IP rotating random Bearer tokens (no per-token bypass)', async () => {
    const { pipeline, handler } = pipelineWith(5, 60);
    const results: unknown[] = [];
    for (let i = 0; i < 10; i += 1) {
      results.push(
        await pipeline.run(
          { headers: { authorization: `Bearer random-${i}` }, clientIp: '6.6.6.6' },
          handler,
        ),
      );
    }
    expect(handler).toHaveBeenCalledTimes(5);
    const denied = results.slice(5);
    expect(denied.every((r) => isProblemDetails(r) && r.status === 429)).toBe(true);
  });

  it('throttles anonymous requests (no token) per IP', async () => {
    const { pipeline, handler } = pipelineWith(3, 60);
    for (let i = 0; i < 5; i += 1) {
      await pipeline.run({ headers: {}, clientIp: '7.7.7.7' }, handler);
    }
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('enforces the per-session budget across IPs', async () => {
    const { pipeline, handler } = pipelineWith(100, 2);
    const ips = ['1.1.1.1', '2.2.2.2', '3.3.3.3'];
    const results: unknown[] = [];
    for (const ip of ips) {
      results.push(await pipeline.run({ headers: HEADERS, clientIp: ip }, handler));
    }
    expect(handler).toHaveBeenCalledTimes(2);
    const last = results[2];
    expect(isProblemDetails(last) && last.status === 429).toBe(true);
  });

  it('gives each session its own budget behind the same IP', async () => {
    const { pipeline, handler } = pipelineWith(100, 1);
    await pipeline.run({ headers: { authorization: 'Bearer a' }, clientIp: '8.8.8.8' }, handler);
    await pipeline.run({ headers: { authorization: 'Bearer b' }, clientIp: '8.8.8.8' }, handler);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
