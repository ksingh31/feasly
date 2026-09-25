/**
 * Sheets sync run-recording tests (admin/05).
 *
 * Verifies the sync service records each run in the `sheets_sync_runs`
 * table: start marker, success finish, failure finish (sanitized error),
 * disabled finish, and the manual trigger label. The run store is faked.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createSheetsSyncService,
  type SheetsSyncServiceDeps,
} from '../src/services/sheets-sync.service';
import type { LeadStore } from '../src/services/lead.store';
import type { EstimateStore } from '../src/services/estimate.store';
import type { SheetsClient } from '../src/services/sheets/sheets-client';
import type {
  SheetsSyncRunStore,
  SheetsSyncRunResult,
  SheetsSyncTrigger,
} from '../src/services/sheets-sync-run.store';

function makeRunStore(): SheetsSyncRunStore & {
  starts: SheetsSyncTrigger[];
  finishes: { runId: string; result: SheetsSyncRunResult }[];
} {
  const store: SheetsSyncRunStore & {
    starts: SheetsSyncTrigger[];
    finishes: { runId: string; result: SheetsSyncRunResult }[];
  } = {
    starts: [],
    finishes: [],
    recordRunStart: async (trigger: SheetsSyncTrigger) => {
      store.starts.push(trigger);
      return `run-${store.starts.length}`;
    },
    recordRunFinish: async (
      runId: string,
      result: SheetsSyncRunResult,
    ) => {
      store.finishes.push({ runId, result });
    },
    getLatestRuns: async () => [],
    getTotalRowsSynced: async () => 0,
    countPendingLeads: async () => 0,
  };
  return store;
}

function makeDeps(
  overrides: Partial<SheetsSyncServiceDeps> = {},
  sheetsImpl?: Partial<SheetsClient>,
) {
  const runs = makeRunStore();
  const leads = {
    findSheetsSyncCandidates: vi.fn().mockResolvedValue([]),
    setSheetsSyncedAt: vi.fn(),
  } as unknown as LeadStore;
  const estimates = {
    findById: vi.fn().mockResolvedValue(null),
  } as unknown as EstimateStore;
  const sheets: SheetsClient = {
    upsertRows: vi.fn().mockResolvedValue(undefined),
    checkAccess: vi.fn().mockResolvedValue(undefined),
    ...sheetsImpl,
  };
  const deps: SheetsSyncServiceDeps = {
    leads,
    estimates,
    sheets,
    enabled: true,
    maxLeadsPerRun: 500,
    runs,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
    ...overrides,
  };
  return { deps, runs };
}

describe('sheets sync run recording', () => {
  it('records a successful timer run', async () => {
    const { deps, runs } = makeDeps();
    const svc = createSheetsSyncService(deps);
    await svc.runSyncCycle();
    expect(runs.starts).toEqual(['timer']);
    expect(runs.finishes).toHaveLength(1);
    expect(runs.finishes[0].result.status).toBe('success');
  });

  it('records the manual trigger label', async () => {
    const { deps, runs } = makeDeps();
    const svc = createSheetsSyncService(deps);
    await svc.runSyncCycle('manual');
    expect(runs.starts).toEqual(['manual']);
  });

  it('records a failed run with a sanitized error', async () => {
    const { deps, runs } = makeDeps({}, {
      upsertRows: vi.fn().mockRejectedValue(new Error('sheets exploded: 503')),
    });
    // One candidate so the upsert path is hit.
    (deps.leads.findSheetsSyncCandidates as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'lead-1' },
    ]);
    // buildSheetRow needs the lead + estimate; fake minimal rows.
    (deps.leads as unknown as { findById: ReturnType<typeof vi.fn> }).findById =
      vi.fn().mockResolvedValue({
        id: 'lead-1',
        estimateId: 'est-1',
        name: 'n',
        email: 'e@x.com',
        phone: null,
        timeline: 't',
        marketingConsent: false,
        consentTs: new Date(),
        tenantKey: null,
        addressKey: 'a',
        leadScore: 0,
        status: 'new',
        source: 'web',
        createdAt: new Date(),
      });
    const svc = createSheetsSyncService(deps);
    await expect(svc.runSyncCycle()).rejects.toThrow();
    expect(runs.starts).toEqual(['timer']);
    expect(runs.finishes).toHaveLength(1);
    const result = runs.finishes[0].result;
    expect(result.status).toBe('failed');
    expect(result.error).toContain('503');
  });

  it('records a disabled run', async () => {
    const { deps, runs } = makeDeps({ enabled: false });
    const svc = createSheetsSyncService(deps);
    const result = await svc.runSyncCycle();
    expect(result.disabled).toBe(true);
    expect(runs.starts).toEqual(['timer']);
    expect(runs.finishes[0].result.status).toBe('disabled');
  });

  it('works without a run store (backwards compatible)', async () => {
    const { deps } = makeDeps();
    const { runs: _runs, ...noRuns } = deps;
    const svc = createSheetsSyncService(noRuns);
    const result = await svc.runSyncCycle();
    expect(result.disabled).toBe(false);
  });
});
