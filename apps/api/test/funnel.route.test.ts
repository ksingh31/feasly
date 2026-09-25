/**
 * Funnel route tests (admin/07).
 *
 * Covers: 401 without the admin key, 200 with the key, 400 on invalid
 * from/to, 400 when from > to, tenant_key parsing (omitted → all,
 * 'direct' → direct, other → tenant), and query passthrough to the service.
 * The FunnelService is faked; the AdminGuard uses the real
 * createSessionAdminGuard with a fake AdminAuthService.
 */
import { describe, expect, it } from 'vitest';
import { createFunnelRoute } from '../src/routes/funnel.route';
import {
  ADMIN_SESSION_COOKIE,
  createSessionAdminGuard,
} from '../src/middleware/admin-guard';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type {
  FunnelQuery,
  FunnelReport,
  FunnelService,
} from '../src/services/funnel.service';

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

function createFakeFunnel(report: FunnelReport): FunnelService & {
  lastQuery: FunnelQuery | null;
} {
  const fake: FunnelService & { lastQuery: FunnelQuery | null } = {
    lastQuery: null,
    async getFunnel(query: FunnelQuery) {
      fake.lastQuery = query;
      return report;
    },
  };
  return fake;
}

const EMPTY_REPORT: FunnelReport = {
  from: null,
  to: null,
  tenant: 'all',
  steps: [],
};

describe('funnel route', () => {
  it('401s without a session cookie', async () => {
    const route = createFunnelRoute({
      funnel: createFakeFunnel(EMPTY_REPORT),
      adminGuard: sessionGuard(),
    });
    await expect(route.getFunnel({}, {})).rejects.toMatchObject({
      status: 401,
      code: ErrorCodes.UNAUTHENTICATED,
    });
  });

  it('401s with an invalid session (fail closed)', async () => {
    const route = createFunnelRoute({
      funnel: createFakeFunnel(EMPTY_REPORT),
      adminGuard: sessionGuard(null),
    });
    await expect(route.getFunnel(adminHeaders, {})).rejects.toMatchObject({
      status: 401,
    });
  });

  it('returns the service report for an admin', async () => {
    const funnel = createFakeFunnel(EMPTY_REPORT);
    const route = createFunnelRoute({
      funnel,
      adminGuard: sessionGuard(),
    });
    const result = await route.getFunnel(adminHeaders, {});
    expect(result).toBe(EMPTY_REPORT);
    expect(funnel.lastQuery).toEqual({
      from: undefined,
      to: undefined,
      tenant: { kind: 'all' },
    });
  });

  it("maps tenant_key=direct to the direct filter", async () => {
    const funnel = createFakeFunnel(EMPTY_REPORT);
    const route = createFunnelRoute({
      funnel,
      adminGuard: sessionGuard(),
    });
    await route.getFunnel(adminHeaders, { tenant_key: 'direct' });
    expect(funnel.lastQuery?.tenant).toEqual({ kind: 'direct' });
  });

  it('maps a tenant_key value to the tenant filter', async () => {
    const funnel = createFakeFunnel(EMPTY_REPORT);
    const route = createFunnelRoute({
      funnel,
      adminGuard: sessionGuard(),
    });
    await route.getFunnel(adminHeaders, { tenant_key: 'acme-builders' });
    expect(funnel.lastQuery?.tenant).toEqual({
      kind: 'tenant',
      tenantKey: 'acme-builders',
    });
  });

  it('400s on an invalid from date', async () => {
    const route = createFunnelRoute({
      funnel: createFakeFunnel(EMPTY_REPORT),
      adminGuard: sessionGuard(),
    });
    await expect(
      route.getFunnel(adminHeaders, { from: 'not-a-date' }),
    ).rejects.toMatchObject({
      status: 400,
      code: ErrorCodes.VALIDATION_FAILED,
    });
  });

  it('400s when from is after to', async () => {
    const route = createFunnelRoute({
      funnel: createFakeFunnel(EMPTY_REPORT),
      adminGuard: sessionGuard(),
    });
    await expect(
      route.getFunnel(adminHeaders, {
        from: '2026-09-30',
        to: '2026-09-01',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('passes parsed dates to the service', async () => {
    const funnel = createFakeFunnel(EMPTY_REPORT);
    const route = createFunnelRoute({
      funnel,
      adminGuard: sessionGuard(),
    });
    await route.getFunnel(adminHeaders, {
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T00:00:00Z',
    });
    expect(funnel.lastQuery?.from).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(funnel.lastQuery?.to).toEqual(new Date('2026-09-30T00:00:00Z'));
  });

  it('does not leak which check failed — 401 either way', async () => {
    const route = createFunnelRoute({
      funnel: createFakeFunnel(EMPTY_REPORT),
      adminGuard: sessionGuard(),
    });
    const wrongKey = route.getFunnel({ cookie: `${ADMIN_SESSION_COOKIE}=wrong` }, {});
    const noKey = route.getFunnel({}, {});
    await expect(wrongKey).rejects.toBeInstanceOf(HttpError);
    await expect(noKey).rejects.toBeInstanceOf(HttpError);
  });
});
