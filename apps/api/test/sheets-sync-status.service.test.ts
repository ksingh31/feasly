/**
 * Sheets sync status service tests (admin/05).
 *
 * Fakes the run store / lead store / sync service at the interface
 * boundary. Covers AC1 (figures reconcile with the store + lead count),
 * AC2 (badge thresholds: failing ≥ 3 consecutive failures, lagging when
 * last success > 2h ago, healthy otherwise), AC3 (409 while a run is in
 * flight; manual run delegates to the worker with trigger 'manual'),
 * and AC4 (recent failures carry sanitized error text, newest first).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createSheetsSyncStatusService,
  type SheetsSyncStatusServiceDeps,
} from '../src/services/sheets-sync-status.service';
import type {
  SheetsSyncRunRecord,
  SheetsSyncRunStore,
} from '../src/services/sheets-sync-run.store';
import type { LeadStore } from '../src/services/lead.store';
import type { SheetsSyncService } from '../src/services/sheets-sync.service';
import { ErrorCodes } from '../src/middleware/errors';

const NOW = new Date('2026-09-26T01:00:00.000Z');
const MIN = 60_000;

function makeRun(
  overrides: Partial<SheetsSyncRunRecord> = {},
): SheetsSyncRunRecord {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    startedAt: new Date(NOW.getTime() - 10 * MIN),
    finishedAt: new Date(NOW.getTime() - 9 * MIN),
    trigger: 'timer',
    actorEmail: null,
    status: 'success',
    syncedCount: 0,
    skippedCount: 0,
    errorMessage: null,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SheetsSyncStatusServiceDeps> = {},
): { deps: SheetsSyncStatusServiceDeps; runs: SheetsSyncRunStore } {
  const runs: SheetsSyncRunStore = {
    startRun: vi.fn(),
    finishRun: vi.fn(),
    recent: vi.fn().mockResolvedValue([]),
    totalSyncedRows: vi.fn().mockResolvedValue(0),
    findInFlight: vi.fn().mockResolvedValue(null),
  };
  const leads: Pick<LeadStore, 'countNeverSynced'> = {
    countNeverSynced: vi.fn().mockResolvedValue(0),
  };
  const sheets: SheetsSyncService = {
    runSyncCycle: vi
      .fn()
      .mockResolvedValue({ synced: 3, skipped: 1, disabled: false, consecutiveFailures: 0 }),
  };
  const deps: SheetsSyncStatusServiceDeps = {
    runs,
    leads,
    sheets,
    sheetsConfigured: true,
    lagAfterHours: 2,
    runStaleAfterMin: 30,
    clock: () => new Date(NOW),
    ...overrides,
  };
  return { deps, runs };
}

describe('sheets sync status service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('healthy: recent success within the window (AC2)', async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.runs.recent).mockResolvedValue([
      makeRun({ status: 'success', syncedCount: 4 }),
    ]);
    vi.mocked(deps.runs.totalSyncedRows).mockResolvedValue(42);
    vi.mocked(deps.leads.countNeverSynced).mockResolvedValue(3);

    const status = createSheetsSyncStatusService(deps).getStatus();
    const s = await status;
    expect(s.last_run_at).toBeTruthy();
    expect(s.last_success_at).toBeTruthy();
    expect(s.rows_synced_total).toBe(42);
    expect(s.pending_count).toBe(3);
    expect(s.consecutive_failures).toBe(0);
    expect(s.lagging).toBe(false);
    expect(s.run_in_flight).toBe(false);
    expect(s.sheets_configured).toBe(true);
  });

  it('failing: ≥ 3 consecutive failures → lagging (AC2)', async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.runs.recent).mockResolvedValue([
      makeRun({ status: 'failed', errorMessage: 'boom 3' }),
      makeRun({ status: 'failed', errorMessage: 'boom 2' }),
      makeRun({ status: 'failed', errorMessage: 'boom 1' }),
      makeRun({
        status: 'success',
        startedAt: new Date(NOW.getTime() - 60 * MIN),
        finishedAt: new Date(NOW.getTime() - 59 * MIN),
      }),
    ]);

    const s = await createSheetsSyncStatusService(deps).getStatus();
    expect(s.consecutive_failures).toBe(3);
    expect(s.lagging).toBe(true);
    expect(s.recent_failures).toHaveLength(3);
    // Newest first.
    expect(s.recent_failures[0].error).toBe('boom 3');
  });

  it('lagging: last success more than 2h ago (AC2)', async () => {
    const { deps } = makeDeps();
    const stale = new Date(NOW.getTime() - 3 * 60 * MIN);
    vi.mocked(deps.runs.recent).mockResolvedValue([
      makeRun({ status: 'success', startedAt: stale, finishedAt: stale }),
    ]);

    const s = await createSheetsSyncStatusService(deps).getStatus();
    expect(s.consecutive_failures).toBe(0);
    expect(s.lagging).toBe(true);
  });

  it('not lagging: last success inside the 2h window', async () => {
    const { deps } = makeDeps();
    const fresh = new Date(NOW.getTime() - 90 * MIN);
    vi.mocked(deps.runs.recent).mockResolvedValue([
      makeRun({ status: 'success', startedAt: fresh, finishedAt: fresh }),
    ]);

    const s = await createSheetsSyncStatusService(deps).getStatus();
    expect(s.lagging).toBe(false);
  });

  it('lagging: runs attempted but never succeeded', async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.runs.recent).mockResolvedValue([
      makeRun({ status: 'failed', errorMessage: 'boom' }),
    ]);

    const s = await createSheetsSyncStatusService(deps).getStatus();
    expect(s.last_success_at).toBeNull();
    expect(s.lagging).toBe(true);
  });

  it('never ran: not lagging, null timestamps (panel shows a note, not an alarm)', async () => {
    const { deps } = makeDeps();
    const s = await createSheetsSyncStatusService(deps).getStatus();
    expect(s.last_run_at).toBeNull();
    expect(s.last_success_at).toBeNull();
    expect(s.lagging).toBe(false);
  });

  it('a success (or disabled) breaks the failure streak; stale running rows are skipped', async () => {
    const { deps } = makeDeps();
    const ancient = new Date(NOW.getTime() - 60 * MIN);
    vi.mocked(deps.runs.recent).mockResolvedValue([
      makeRun({ status: 'failed', errorMessage: 'b2' }),
      makeRun({ status: 'failed', errorMessage: 'b1' }),
      // Stale crashed-instance row: neither success nor failure.
      makeRun({ status: 'running', startedAt: ancient, finishedAt: null }),
      makeRun({
        status: 'success',
        startedAt: new Date(NOW.getTime() - 90 * MIN),
        finishedAt: new Date(NOW.getTime() - 89 * MIN),
      }),
    ]);

    const s = await createSheetsSyncStatusService(deps).getStatus();
    expect(s.consecutive_failures).toBe(2);
    expect(s.lagging).toBe(false);
  });

  it('recent failures are capped at 5 with sanitized text (AC4)', async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.runs.recent).mockResolvedValue(
      Array.from({ length: 7 }, (_, i) =>
        makeRun({ status: 'failed', errorMessage: `err-${i}` }),
      ),
    );

    const s = await createSheetsSyncStatusService(deps).getStatus();
    expect(s.recent_failures).toHaveLength(5);
    expect(s.recent_failures[0].error).toBe('err-0');
  });

  it('surfaces run_in_flight from the store', async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.runs.findInFlight).mockResolvedValue(
      makeRun({ status: 'running' }),
    );
    const s = await createSheetsSyncStatusService(deps).getStatus();
    expect(s.run_in_flight).toBe(true);
  });

  it('triggerManualRun throws 409 while a run is in flight (AC3)', async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.runs.findInFlight).mockResolvedValue(
      makeRun({ status: 'running' }),
    );

    await expect(
      createSheetsSyncStatusService(deps).triggerManualRun('karanbirsingh667@gmail.com'),
    ).rejects.toThrow(
      expect.objectContaining({ status: 409, code: ErrorCodes.CONFLICT }),
    );
    expect(deps.sheets.runSyncCycle).not.toHaveBeenCalled();
  });

  it("triggerManualRun delegates to the worker with trigger 'manual' (AC3)", async () => {
    const { deps } = makeDeps();
    const r = await createSheetsSyncStatusService(deps).triggerManualRun(
      'karanbirsingh667@gmail.com',
    );
    expect(deps.sheets.runSyncCycle).toHaveBeenCalledWith({
      trigger: 'manual',
      actorEmail: 'karanbirsingh667@gmail.com',
    });
    expect(r.synced).toBe(3);
    expect(r.triggered_at).toBe(NOW.toISOString());
  });
});
