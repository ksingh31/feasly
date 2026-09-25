/**
 * Sheets sync status service tests (admin/05).
 *
 * The run store is faked at the interface boundary. Tests cover the badge
 * rules: healthy (last run succeeded), lagging (3+ consecutive failures),
 * failing (latest run failed), disabled (Sheets not configured), plus
 * in-flight detection and the never-ran edge cases.
 */
import { describe, expect, it } from 'vitest';
import {
  createSheetsSyncStatusService,
  type SheetsSyncStatusServiceDeps,
} from '../src/services/sheets-sync-status.service';
import type {
  SheetsSyncRunRecord,
  SheetsSyncRunStore,
} from '../src/services/sheets-sync-run.store';

function makeRun(
  overrides: Partial<SheetsSyncRunRecord> = {},
): SheetsSyncRunRecord {
  const now = new Date('2026-09-25T12:00:00Z');
  return {
    id: 'run-1',
    startedAt: now,
    finishedAt: now,
    status: 'success',
    rowsSynced: 5,
    rowsSkipped: 1,
    error: null,
    trigger: 'timer',
    ...overrides,
  };
}

function makeStore(
  runs: readonly SheetsSyncRunRecord[],
  opts: { pending?: number; total?: number } = {},
): SheetsSyncRunStore {
  return {
    recordRunStart: async () => 'run-new',
    recordRunFinish: async () => {},
    getLatestRuns: async (limit: number) => runs.slice(0, limit),
    getTotalRowsSynced: async () => opts.total ?? 0,
    countPendingLeads: async () => opts.pending ?? 0,
  };
}

function makeService(
  runs: readonly SheetsSyncRunRecord[],
  opts: { enabled?: boolean; pending?: number; total?: number } = {},
) {
  const deps: SheetsSyncStatusServiceDeps = {
    runs: makeStore(runs, opts),
    enabled: opts.enabled ?? true,
  };
  return createSheetsSyncStatusService(deps);
}

describe('sheets sync status service', () => {
  it('is healthy when the latest run succeeded', async () => {
    const svc = makeService([makeRun({ status: 'success' })], {
      pending: 0,
      total: 42,
    });
    const status = await svc.getStatus();
    expect(status.health).toBe('healthy');
    expect(status.lastRunStatus).toBe('success');
    expect(status.lastRunRowsSynced).toBe(5);
    expect(status.pendingLeads).toBe(0);
    expect(status.totalRowsSynced).toBe(42);
    expect(status.runInFlight).toBe(false);
    expect(status.lastError).toBeNull();
  });

  it('is failing when the latest run failed (below lagging threshold)', async () => {
    const svc = makeService([
      makeRun({ status: 'failed', error: 'Error: 503' }),
      makeRun({ status: 'success' }),
    ]);
    const status = await svc.getStatus();
    expect(status.health).toBe('failing');
    expect(status.lastError).toBe('Error: 503');
  });

  it('is lagging after 3 consecutive failures', async () => {
    const svc = makeService([
      makeRun({ status: 'failed', error: 'Error: 503' }),
      makeRun({ status: 'failed', error: 'Error: 503' }),
      makeRun({ status: 'failed', error: 'Error: timeout' }),
      makeRun({ status: 'success' }),
    ]);
    const status = await svc.getStatus();
    expect(status.health).toBe('lagging');
  });

  it('is disabled when Sheets is not configured', async () => {
    const svc = makeService([makeRun({ status: 'success' })], {
      enabled: false,
    });
    const status = await svc.getStatus();
    expect(status.health).toBe('disabled');
  });

  it('is healthy when never ran and nothing is pending', async () => {
    const svc = makeService([], { pending: 0 });
    const status = await svc.getStatus();
    expect(status.health).toBe('healthy');
    expect(status.lastSyncAt).toBeNull();
    expect(status.lastRunStatus).toBeNull();
  });

  it('is failing when never ran but leads are pending', async () => {
    const svc = makeService([], { pending: 3 });
    const status = await svc.getStatus();
    expect(status.health).toBe('failing');
    expect(status.pendingLeads).toBe(3);
  });

  it('detects a run in flight', async () => {
    const inFlight = makeRun({ finishedAt: null, status: 'success' });
    const svc = makeService([inFlight, makeRun({ status: 'success' })]);
    expect(await svc.isRunInFlight()).toBe(true);
    const status = await svc.getStatus();
    expect(status.runInFlight).toBe(true);
    // Health is computed from the latest FINISHED run.
    expect(status.health).toBe('healthy');
  });

  it('returns recent runs newest-first', async () => {
    const older = makeRun({
      id: 'run-old',
      startedAt: new Date('2026-09-25T10:00:00Z'),
    });
    const newer = makeRun({
      id: 'run-new',
      startedAt: new Date('2026-09-25T11:00:00Z'),
    });
    const svc = makeService([newer, older]);
    const status = await svc.getStatus();
    expect(status.recentRuns.map((r) => r.id)).toEqual(['run-new', 'run-old']);
  });
});
