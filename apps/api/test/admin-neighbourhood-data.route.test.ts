/**
 * Admin neighbourhood-data "refresh now" route (#773): admin-gated,
 * validates the provider, calls the service once, audit-logs every attempt
 * with the admin's email. (Role → permission enforcement for the path is
 * pinned by the registry permission-matrix snapshot: super_admin + admin.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { AdminAuditStore } from '../src/services/admin-audit.store';
import type { NeighbourhoodRefreshService } from '../src/services/neighbourhood-data/neighbourhood-refresh.service';
import {
  NEIGHBOURHOOD_REFRESH_AUDIT_ACTION,
  createAdminNeighbourhoodDataRoute,
} from '../src/routes/admin-neighbourhood-data.route';
import { ROUTE_REGISTRY } from '../src/registry/route-registry';

const ADMIN = { cookie: 'admin-session=ok' };

function makeDeps() {
  const appended: Array<{ action: string; actorEmail: string | null; detail?: string }> = [];
  const refresh: NeighbourhoodRefreshService = {
    runDue: vi.fn(),
    refreshNow: vi.fn(async (provider) => ({
      provider,
      implementation: 'calgary-open-data',
      outcome: 'ok' as const,
      rowsChanged: 4,
      rowsPruned: 1,
      rowsTotal: 506,
      durationMs: 12,
      consecutiveFailures: 0,
    })),
  };
  const audit: AdminAuditStore = {
    append: vi.fn(async (args) => {
      appended.push(args);
      return { id: 'a', action: args.action, actorEmail: args.actorEmail, detail: args.detail ?? null, createdAt: new Date() };
    }),
    recent: vi.fn(async () => []),
    log: vi.fn(async () => {}),
  };
  return {
    appended,
    refresh,
    audit,
    adminGuard: {
      async requireAdmin(headers: Record<string, string | string[] | undefined>) {
        if (headers['cookie'] !== ADMIN.cookie) {
          throw new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Admin authentication required.', false);
        }
      },
      async getAdminEmail() {
        return 'ops@feasly.test';
      },
    },
  };
}

describe('admin neighbourhood-data refresh route (#773)', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('401 without an admin session — nothing runs, nothing audited', async () => {
    const route = createAdminNeighbourhoodDataRoute(deps);
    const error = await route.refresh({}, 'amenities').catch((e) => e);
    expect((error as HttpError).code).toBe(ErrorCodes.UNAUTHENTICATED);
    expect(deps.refresh.refreshNow).not.toHaveBeenCalled();
    expect(deps.appended).toHaveLength(0);
  });

  it('400 for an unknown provider', async () => {
    const route = createAdminNeighbourhoodDataRoute(deps);
    const error = await route.refresh(ADMIN, 'everything').catch((e) => e);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).code).toBe(ErrorCodes.VALIDATION_FAILED);
    expect(deps.refresh.refreshNow).not.toHaveBeenCalled();
  });

  it('runs the provider refresh and returns counts, audit-logged with the admin email', async () => {
    const route = createAdminNeighbourhoodDataRoute(deps);
    const res = await route.refresh(ADMIN, 'school-directory');
    expect(deps.refresh.refreshNow).toHaveBeenCalledWith('school-directory');
    expect(res).toEqual({
      provider: 'school-directory',
      implementation: 'calgary-open-data',
      outcome: 'ok',
      rows_changed: 4,
      rows_pruned: 1,
      rows_total: 506,
      consecutive_failures: 0,
      error: null,
    });
    expect(deps.appended).toEqual([
      {
        action: NEIGHBOURHOOD_REFRESH_AUDIT_ACTION,
        actorEmail: 'ops@feasly.test',
        detail: 'provider=school-directory impl=calgary-open-data outcome=ok changed=4 pruned=1',
      },
    ]);
  });

  it('audit-logs an unexpected error and rethrows it', async () => {
    vi.mocked(deps.refresh.refreshNow).mockRejectedValueOnce(new TypeError('db down'));
    const route = createAdminNeighbourhoodDataRoute(deps);
    await expect(route.refresh(ADMIN, 'commute')).rejects.toThrow('db down');
    expect(deps.appended[0]!.detail).toBe('provider=commute error=TypeError');
  });

  it('is registered as an ops:manage admin route', () => {
    const entry = ROUTE_REGISTRY.find((r) => r.path === '/api/v1/admin/neighbourhood-data/{provider}/refresh');
    expect(entry).toMatchObject({ method: 'POST', auth: 'admin', permissions: ['ops:manage'], status: 'live' });
  });
});
