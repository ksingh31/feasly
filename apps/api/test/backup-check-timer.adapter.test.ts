/**
 * Backup-check timer adapter test (admin/06 `backup_missed`).
 *
 * The adapter is thin by design; this pins its wiring:
 * - unconfigured service → fail-closed, no alert calls, one log line
 * - healthy chain → notifyRecovered('backup_missed'), no failure email
 * - stale chain → notifyFailure('backup_missed', …) with staleSince
 * - probe error → skip, no alert calls
 * Logs carry aggregates only — never tokens or connection strings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const notifyFailure = vi.fn();
const notifyRecovered = vi.fn();
const checkBackupFreshness = vi.fn();

let backupCheckService: { checkBackupFreshness: typeof checkBackupFreshness } | undefined;

const fakeApp = {
  get backupCheckService() {
    return backupCheckService;
  },
  opsAlertsService: { notifyFailure, notifyRecovered },
};

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
}));

// Imported after the mock: the adapter binds `createComposition` lazily via
// getApp(), but the module import itself must see the mocked barrel.
import { backupCheckTimerHandler } from '../src/functions/backup-check-timer';

const STALE_SINCE = new Date('2026-09-25T23:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  backupCheckService = { checkBackupFreshness };
});

describe('backup-check-timer adapter', () => {
  it('fails closed when the backup check is not configured', async () => {
    backupCheckService = undefined;
    const logs: unknown[][] = [];
    await backupCheckTimerHandler({
      log: (...args: unknown[]) => void logs.push(args),
    });
    expect(notifyFailure).not.toHaveBeenCalled();
    expect(notifyRecovered).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(String(logs[0]?.[0])).toMatch(/fail-closed/);
  });

  it('sends the all-clear when the chain is healthy', async () => {
    checkBackupFreshness.mockResolvedValue({
      healthy: true,
      server: 'feasly-dev-pg-4fhkep',
      retentionDays: 7,
      earliestRestore: new Date('2026-09-25T23:00:00Z'),
      staleHours: 1,
      staleSince: null,
      reason: null,
    });
    const logs: unknown[][] = [];
    await backupCheckTimerHandler({
      log: (...args: unknown[]) => void logs.push(args),
    });
    expect(notifyRecovered).toHaveBeenCalledWith('backup_missed');
    expect(notifyFailure).not.toHaveBeenCalled();
    expect(String(logs[0]?.[0])).toContain('retentionDays=7');
  });

  it('fires the backup_missed alert when the chain is stale', async () => {
    checkBackupFreshness.mockResolvedValue({
      healthy: false,
      server: 'feasly-dev-pg-4fhkep',
      retentionDays: 7,
      earliestRestore: new Date('2026-09-23T22:00:00Z'),
      staleHours: 50,
      staleSince: STALE_SINCE,
      reason: 'earliest restore point is 50.0h old',
    });
    const logs: unknown[][] = [];
    await backupCheckTimerHandler({
      log: (...args: unknown[]) => void logs.push(args),
    });
    expect(notifyFailure).toHaveBeenCalledWith('backup_missed', {
      consecutiveFailures: 1,
      firstFailureAt: STALE_SINCE,
    });
    expect(notifyRecovered).not.toHaveBeenCalled();
    const line = String(logs[0]?.[0]);
    expect(line).toMatch(/BACKUP STALE/);
    // No tokens or connection strings in the log line.
    expect(line).not.toMatch(/bearer|token|password|secret/i);
  });

  it('skips without alerting when the probe itself errors', async () => {
    checkBackupFreshness.mockRejectedValue(new Error('boom'));
    const logs: unknown[][] = [];
    await backupCheckTimerHandler({
      log: (...args: unknown[]) => void logs.push(args),
    });
    expect(notifyFailure).not.toHaveBeenCalled();
    expect(notifyRecovered).not.toHaveBeenCalled();
    expect(String(logs[0]?.[0])).toMatch(/probe errored/);
  });
});
