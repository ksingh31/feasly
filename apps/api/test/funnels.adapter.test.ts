/**
 * Funnels adapter test.
 *
 * Regression coverage for tracked bug goal_a49e749a71b6: the registry
 * declares `analytics:read` for GET /api/v1/admin/funnels, but the old-style
 * adapter never called `enforceRoutePermissions` — any valid admin session
 * could read the funnel aggregates. The adapter must enforce the registry
 * permission BEFORE the route runs, and a session without `analytics:read`
 * must get 403 without the route (or DB) being touched.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { FunnelReport } from '../src/services/funnel.service';

const SESSION_COOKIE = 'feasly_admin_session=valid-test-session';

const EMPTY_REPORT: FunnelReport = {
  from: null,
  to: null,
  tenant: 'all',
  steps: [],
};

const getFunnel = vi.hoisted(() => vi.fn());
const enforceRoutePermissions = vi.hoisted(() => vi.fn());

// The fake composition wires a stubbed funnel route; the fake pipeline
// mimics the real one by converting a thrown HttpError into a
// problem-details-shaped result (status-bearing), like the real pipeline
// does via toProblemDetails.
const fakeApp = {
  requestPipeline: {
    run: async (
      _request: unknown,
      handler: () => Promise<unknown>,
    ): Promise<unknown> => {
      try {
        return await handler();
      } catch (err) {
        if (err instanceof HttpError) {
          return {
            status: err.status,
            code: err.code,
            title: err.message,
            correlationId: 'corr-1',
          };
        }
        throw err;
      }
    },
  },
  permissionGuard: {},
  funnelRoute: { getFunnel },
};

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
  loadConfig: () => ({ corsOrigins: [] }),
  middleware: {
    resolveCorsHeaders: () => ({}),
    isPreflight: () => false,
    preflightHeaders: () => ({}),
    ensureCorrelationId: () => 'corr-1',
    securityHeaders: () => ({}),
    isProblemDetails: (result: unknown) =>
      typeof result === 'object' &&
      result !== null &&
      typeof (result as { status?: unknown }).status === 'number',
    problemResponseHeaders: () => ({}),
    enforceRoutePermissions,
  },
}));

// Imported after the mock so the adapter's lazy getApp() sees the stub.
import { funnelsHandler } from '../src/functions/funnels';

function context() {
  return { res: undefined as unknown, log: () => {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  enforceRoutePermissions.mockResolvedValue(undefined);
  getFunnel.mockResolvedValue(EMPTY_REPORT);
});

describe('funnels adapter', () => {
  it('enforces the registry permission before running the route', async () => {
    const ctx = context();
    await funnelsHandler(ctx, {
      method: 'GET',
      headers: { cookie: SESSION_COOKIE },
      query: {},
    });

    // The registry entry for GET /api/v1/admin/funnels declares
    // `analytics:read` — the adapter must enforce exactly that path.
    expect(enforceRoutePermissions).toHaveBeenCalledTimes(1);
    expect(enforceRoutePermissions).toHaveBeenCalledWith(
      fakeApp.permissionGuard,
      'GET',
      '/api/v1/admin/funnels',
      expect.objectContaining({ cookie: SESSION_COOKIE }),
    );

    const res = ctx.res as { status: number; body: unknown };
    expect(res.status).toBe(200);
    expect(res.body).toEqual(EMPTY_REPORT);
  });

  it('returns 403 without touching the route when analytics:read is missing', async () => {
    // Simulates what enforceRoutePermissions throws for a session whose
    // effective permissions lack analytics:read (403, audit-logged).
    enforceRoutePermissions.mockRejectedValue(
      new HttpError(
        403,
        ErrorCodes.FORBIDDEN,
        'Missing required permission: analytics:read.',
        false,
      ),
    );

    const ctx = context();
    await funnelsHandler(ctx, {
      method: 'GET',
      headers: { cookie: SESSION_COOKIE },
      query: {},
    });

    const res = ctx.res as { status: number; body: unknown };
    expect(res.status).toBe(403);
    expect(getFunnel).not.toHaveBeenCalled();
  });
});
