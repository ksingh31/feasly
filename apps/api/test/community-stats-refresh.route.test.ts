/**
 * Community-stats manual refresh route tests (neighbourhood/05).
 *
 * The route is thin: admin guard → one service method → audit-log the
 * attempt → response shape. Covers: 401 without the admin key, the happy
 * path (counts + audit entry), and the failure path (audit entry with the
 * error class, error rethrown).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createCommunityStatsRefreshRoute,
  MANUAL_REFRESH_AUDIT_ACTION,
  type CommunityStatsRefreshRouteDeps,
} from '../src/routes/community-stats-refresh.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { CommunityStatsRefreshService } from '../src/services/community-stats-refresh.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';

const ADMIN_HEADERS = { 'x-admin-key': 'secret-admin-key' };

const REFRESH_RESULT = {
  refreshed: 212,
  skipped: 3,
  rollYear: '2025',
  refreshedAt: new Date('2026-10-01T00:00:00Z'),
  consecutiveFailures: 0,
};

function makeDeps(
  overrides: Partial<{
    refreshImpl: () => Promise<typeof REFRESH_RESULT>;
  }> = {},
): CommunityStatsRefreshRouteDeps & {
  appended: { action: string; actor: string; detail?: string }[];
} {
  const appended: { action: string; actor: string; detail?: string }[] = [];
  const refresh: CommunityStatsRefreshService = {
    runRefreshCycle: vi.fn(overrides.refreshImpl ?? (async () => REFRESH_RESULT)),
  };
  const audit: AdminAuditStore = {
    append: vi.fn(async (args) => {
      appended.push(args);
      return {
        id: 'audit-1',
        action: args.action,
        actor: args.actor,
        detail: args.detail ?? null,
        createdAt: new Date(),
      };
    }),
    recent: vi.fn(async () => []),
  };
  return {
    appended,
    refresh,
    audit,
    adminGuard: {
      requireAdmin(headers) {
        if (headers['x-admin-key'] !== 'secret-admin-key') {
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

describe('community-stats manual refresh route', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('rejects callers without the admin key', async () => {
    const route = createCommunityStatsRefreshRoute(deps);
    const error = await route.trigger({}).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe(ErrorCodes.UNAUTHENTICATED);
    expect(deps.appended).toHaveLength(0);
  });

  it('runs one refresh cycle and returns the counts', async () => {
    const route = createCommunityStatsRefreshRoute(deps);
    const response = await route.trigger(ADMIN_HEADERS);
    expect(deps.refresh.runRefreshCycle).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      refreshed: 212,
      skipped: 3,
      roll_year: '2025',
      refreshed_at: '2026-10-01T00:00:00.000Z',
    });
  });

  it('audit-logs a successful manual trigger with the result counts', async () => {
    const route = createCommunityStatsRefreshRoute(deps);
    await route.trigger(ADMIN_HEADERS);
    expect(deps.appended).toHaveLength(1);
    expect(deps.appended[0]).toMatchObject({
      action: MANUAL_REFRESH_AUDIT_ACTION,
      actor: 'admin',
    });
    expect(deps.appended[0]!.detail).toContain('refreshed=212');
    expect(deps.appended[0]!.detail).toContain('skipped=3');
    expect(deps.appended[0]!.detail).toContain('roll_year=2025');
    // No PII in the audit detail.
    expect(deps.appended[0]!.detail).not.toMatch(/@/);
  });

  it('audit-logs a failed manual trigger and rethrows the error', async () => {
    deps = makeDeps({
      refreshImpl: async () => {
        throw new Error('Socrata unreachable: timeout');
      },
    });
    const route = createCommunityStatsRefreshRoute(deps);
    await expect(route.trigger(ADMIN_HEADERS)).rejects.toThrow(
      'Socrata unreachable',
    );
    expect(deps.appended).toHaveLength(1);
    expect(deps.appended[0]).toMatchObject({
      action: MANUAL_REFRESH_AUDIT_ACTION,
      actor: 'admin',
    });
    expect(deps.appended[0]!.detail).toContain('error');
  });

  it('a broken audit store never masks the refresh outcome', async () => {
    const route = createCommunityStatsRefreshRoute({
      ...deps,
      audit: {
        append: vi.fn(async () => {
          throw new Error('audit db down');
        }),
        recent: vi.fn(async () => []),
      },
    });
    // Refresh succeeded — the response still comes back.
    const response = await route.trigger(ADMIN_HEADERS);
    expect(response.refreshed).toBe(212);
  });
});
