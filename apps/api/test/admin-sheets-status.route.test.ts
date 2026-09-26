/**
 * Admin Sheets-sync status route tests (admin/05).
 *
 * The route is thin: admin guard → one service method → response shape.
 * Business logic lives in sheets-sync-status.service (covered separately).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAdminSheetsStatusRoute,
  type AdminSheetsStatusRouteDeps,
} from '../src/routes/admin-sheets-status.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { SheetsSyncStatusService } from '../src/services/sheets-sync-status.service';
import type { SheetsSyncStatusResponse } from '@feasly/contracts';

const ADMIN_HEADERS = { cookie: 'feasly_admin_session=valid-test-session' };
const ADMIN_EMAIL = 'karanbirsingh667@gmail.com';

function makeGuard() {
  return {
    async requireAdmin(
      headers: Record<string, string | string[] | undefined>,
    ) {
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
    async getAdminEmail(
      headers: Record<string, string | string[] | undefined>,
    ) {
      const cookie = headers['cookie'];
      const value = Array.isArray(cookie) ? cookie[0] : cookie;
      return value === 'feasly_admin_session=valid-test-session'
        ? ADMIN_EMAIL
        : null;
    },
  };
}

function makeDeps(): AdminSheetsStatusRouteDeps & {
  status: SheetsSyncStatusService;
} {
  const status: SheetsSyncStatusService = {
    getStatus: vi.fn().mockResolvedValue({
      last_run_at: '2026-09-26T00:00:00.000Z',
      last_success_at: '2026-09-26T00:00:00.000Z',
      rows_synced_total: 42,
      pending_count: 3,
      consecutive_failures: 0,
      lagging: false,
      run_in_flight: false,
      sheets_configured: true,
      recent_failures: [],
    } satisfies SheetsSyncStatusResponse),
    triggerManualRun: vi.fn(),
  };
  return { status, adminGuard: makeGuard() };
}

describe('admin-sheets-status route (admin/05)', () => {
  it('getStatus: admin passes → returns the service payload', async () => {
    const deps = makeDeps();
    const route = createAdminSheetsStatusRoute(deps);

    const result = await route.getStatus(ADMIN_HEADERS);

    expect(deps.status.getStatus).toHaveBeenCalledTimes(1);
    expect(result.pending_count).toBe(3);
    expect(result.lagging).toBe(false);
  });

  it('getStatus: unauthenticated → 401, service never called', async () => {
    const deps = makeDeps();
    const route = createAdminSheetsStatusRoute(deps);

    await expect(route.getStatus({})).rejects.toThrow(
      expect.objectContaining({ status: 401 }),
    );
    expect(deps.status.getStatus).not.toHaveBeenCalled();
  });
});
