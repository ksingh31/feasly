/**
 * Admin Sheets-sync manual-trigger route tests (admin/05).
 *
 * Covers AC3: "Sync now" is audit-logged with the admin's email on both
 * success and failure, the worker outcome is returned, and a 409 from the
 * service (run in flight) propagates with an audit row on the error path.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAdminSheetsSyncNowRoute,
  MANUAL_SHEETS_SYNC_AUDIT_ACTION,
  type AdminSheetsSyncNowRouteDeps,
} from '../src/routes/admin-sheets-sync-now.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { SheetsSyncStatusService } from '../src/services/sheets-sync-status.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';

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

function makeDeps(): AdminSheetsSyncNowRouteDeps & {
  status: SheetsSyncStatusService;
  audit: AdminAuditStore;
} {
  const status: SheetsSyncStatusService = {
    getStatus: vi.fn(),
    triggerManualRun: vi.fn().mockResolvedValue({
      synced: 3,
      skipped: 1,
      disabled: false,
      triggered_at: '2026-09-26T01:00:00.000Z',
    }),
  };
  const audit: AdminAuditStore = {
    append: vi.fn().mockResolvedValue({
      id: 'audit-1',
      action: MANUAL_SHEETS_SYNC_AUDIT_ACTION,
      actorEmail: ADMIN_EMAIL,
      detail: null,
      createdAt: new Date(),
    }),
    log: vi.fn().mockResolvedValue(undefined),
    recent: vi.fn().mockResolvedValue([]),
  };
  return { status, audit, adminGuard: makeGuard() };
}

describe('admin-sheets-sync-now route (admin/05)', () => {
  it('trigger: audit-logs the attempt with the admin email (AC3)', async () => {
    const deps = makeDeps();
    const route = createAdminSheetsSyncNowRoute(deps);

    const result = await route.trigger(ADMIN_HEADERS);

    expect(deps.status.triggerManualRun).toHaveBeenCalledWith(ADMIN_EMAIL);
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: MANUAL_SHEETS_SYNC_AUDIT_ACTION,
        actorEmail: ADMIN_EMAIL,
      }),
    );
    const detail = vi.mocked(deps.audit.append).mock.calls[0][0].detail;
    expect(detail).toContain('ok');
    expect(result.synced).toBe(3);
  });

  it('trigger: unauthenticated → 401, nothing triggered or logged', async () => {
    const deps = makeDeps();
    const route = createAdminSheetsSyncNowRoute(deps);

    await expect(route.trigger({})).rejects.toThrow(
      expect.objectContaining({ status: 401 }),
    );
    expect(deps.status.triggerManualRun).not.toHaveBeenCalled();
    expect(deps.audit.append).not.toHaveBeenCalled();
  });

  it('trigger: 409 from the service propagates and is audit-logged', async () => {
    const deps = makeDeps();
    vi.mocked(deps.status.triggerManualRun).mockRejectedValue(
      new HttpError(409, ErrorCodes.CONFLICT, 'in flight', true),
    );
    const route = createAdminSheetsSyncNowRoute(deps);

    await expect(route.trigger(ADMIN_HEADERS)).rejects.toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: MANUAL_SHEETS_SYNC_AUDIT_ACTION,
        actorEmail: ADMIN_EMAIL,
        detail: expect.stringContaining('error'),
      }),
    );
  });

  it('trigger: a failing audit append never masks the sync outcome', async () => {
    const deps = makeDeps();
    vi.mocked(deps.audit.append).mockRejectedValue(new Error('db down'));
    const route = createAdminSheetsSyncNowRoute(deps);

    const result = await route.trigger(ADMIN_HEADERS);
    expect(result.synced).toBe(3);
  });
});
