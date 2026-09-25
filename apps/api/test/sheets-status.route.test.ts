/**
 * Sheets status route tests (admin/05).
 *
 * Covers: 401 without the admin key, 200 status with the key, 409 when a
 * run is in flight, and manual-trigger passthrough to the sync service.
 * Services and the AdminGuard are faked; the guard fake checks the
 * interim X-Admin-Key header (session auth lands with admin/01).
 */
import { describe, expect, it } from 'vitest';
import { createSheetsStatusRoute } from '../src/routes/sheets-status.route';
import type { AdminGuard } from '../src/middleware/admin-guard';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type {
  SheetsSyncStatus,
  SheetsSyncStatusService,
} from '../src/services/sheets-sync-status.service';
import type {
  SheetsSyncResult,
  SheetsSyncService,
  SheetsSyncTrigger,
} from '../src/services/sheets-sync.service';

const ADMIN_KEY = 'test-admin-key';
const adminHeaders = { 'x-admin-key': ADMIN_KEY };

const HEALTHY_STATUS: SheetsSyncStatus = {
  health: 'healthy',
  lastSyncAt: '2026-09-25T12:00:00.000Z',
  lastRunStatus: 'success',
  lastRunRowsSynced: 5,
  lastError: null,
  pendingLeads: 0,
  totalRowsSynced: 42,
  runInFlight: false,
  recentRuns: [],
};

const SYNC_RESULT: SheetsSyncResult = {
  synced: 3,
  skipped: 0,
  disabled: false,
  consecutiveFailures: 0,
};

function createFakeStatus(
  status: SheetsSyncStatus,
  inFlight = false,
): SheetsSyncStatusService {
  return {
    getStatus: async () => status,
    isRunInFlight: async () => inFlight,
  };
}

function createFakeSync(result: SheetsSyncResult): SheetsSyncService & {
  lastTrigger: SheetsSyncTrigger | null;
} {
  const fake: SheetsSyncService & { lastTrigger: SheetsSyncTrigger | null } = {
    lastTrigger: null,
    async runSyncCycle(trigger: SheetsSyncTrigger = 'timer') {
      fake.lastTrigger = trigger;
      return result;
    },
  };
  return fake;
}

function makeRoute(opts: {
  status?: SheetsSyncStatus;
  inFlight?: boolean;
  adminApiKey?: string;
} = {}) {
  const sync = createFakeSync(SYNC_RESULT);
  const expectedKey = opts.adminApiKey ?? ADMIN_KEY;
  const adminGuard: AdminGuard = {
    async requireAdmin(headers) {
      if (headers['x-admin-key'] !== expectedKey) {
        throw new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Unauthorized');
      }
    },
    async getAdminEmail(headers) {
      return headers['x-admin-key'] === expectedKey
        ? 'test-admin@example.com'
        : null;
    },
  };
  const route = createSheetsStatusRoute({
    status: createFakeStatus(opts.status ?? HEALTHY_STATUS, opts.inFlight),
    sync,
    adminGuard,
  });
  return { route, sync };
}

describe('sheets status route', () => {
  it('401s without the admin key', async () => {
    const { route } = makeRoute();
    await expect(route.getStatus({})).rejects.toMatchObject({
      status: 401,
      code: ErrorCodes.UNAUTHENTICATED,
    });
    await expect(route.triggerSync({})).rejects.toMatchObject({
      status: 401,
      code: ErrorCodes.UNAUTHENTICATED,
    });
  });

  it('returns the status with the admin key', async () => {
    const { route } = makeRoute();
    const status = await route.getStatus(adminHeaders);
    expect(status.health).toBe('healthy');
    expect(status.totalRowsSynced).toBe(42);
  });

  it('409s the manual trigger when a run is in flight', async () => {
    const { route, sync } = makeRoute({ inFlight: true });
    await expect(route.triggerSync(adminHeaders)).rejects.toMatchObject({
      status: 409,
      code: ErrorCodes.CONFLICT,
    });
    // The sync service must NOT have been called.
    expect(sync.lastTrigger).toBeNull();
  });

  it('triggers a manual sync run with the admin key', async () => {
    const { route, sync } = makeRoute();
    const result = await route.triggerSync(adminHeaders);
    expect(result.synced).toBe(3);
    expect(sync.lastTrigger).toBe('manual');
  });
});
