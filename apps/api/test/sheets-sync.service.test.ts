/**
 * Sheets sync service tests (admin/04).
 *
 * The SheetsClient is faked at the interface boundary (not the Google API).
 * Tests cover: upsert of new leads, update of modified leads, watermark
 * stamping, zero writes to leads except the watermark, failure→retry,
 * and 3-consecutive-failures→alert.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createSheetsSyncService,
  type SheetsSyncServiceDeps,
} from '../src/services/sheets-sync.service';
import type { LeadStore, LeadRecord } from '../src/services/lead.store';
import type { EstimateStore } from '../src/services/estimate.store';
import type {
  SheetsSyncStateRecord,
  SheetsSyncStateStore,
} from '../src/services/sheets-sync-state.store';
import type { SheetsClient, SheetLeadRow } from '../src/services/sheets/sheets-client';
import type { SheetsSyncRunStore } from '../src/services/sheets-sync-run.store';

function makeLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  const now = new Date('2026-09-25T00:00:00Z');
  return {
    id: 'lead-1',
    estimateId: 'est-1',
    addressKey: '123 Main St Calgary',
    email: 'test@example.com',
    name: 'Test User',
    phone: '403-555-0100',
    timeline: '3-6 months',
    marketingConsent: true,
    consentTs: now,
    tenantKey: null,
    source: 'web',
    quarantined: false,
    sandbox: false,
    leadScore: 75,
    status: 'new',
    unsubscribedAt: null,
    nudgeSentAt: null,
    sheetsSyncedAt: null,
    updatedAt: now,
    createdAt: now,
    ...overrides,
  };
}

function makeSyncStateStore(initial?: Partial<SheetsSyncStateRecord>) {
  let state: SheetsSyncStateRecord = {
    lastRunAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    firstFailureAt: null,
    rowsSyncedTotal: 0,
    lagging: false,
    updatedAt: new Date('2026-09-25T00:00:00Z'),
    ...initial,
  };
  const store: SheetsSyncStateStore = {
    get: vi.fn().mockImplementation(async () => ({ ...state })),
    update: vi.fn().mockImplementation(async (patch) => {
      state = { ...state, ...patch, updatedAt: new Date() };
      return { ...state };
    }),
  };
  return { store, getState: () => ({ ...state }) };
}

function makeDeps(overrides: Partial<SheetsSyncServiceDeps> = {}) {
  const leads: LeadStore = {
    findRecentByEmailAndAddress: vi.fn(),
    insert: vi.fn(),
    updateOnRepeat: vi.fn(),
    findNewestEstimateIdByEmailAndAddress: vi.fn(),
    appendNote: vi.fn(),
    getNotes: vi.fn(),
    appendStatusHistory: vi.fn(),
    getStatusHistory: vi.fn(),
    listLeads: vi.fn(),
    findById: vi.fn(),
    findByEstimateId: vi.fn().mockResolvedValue(null),
    setUnsubscribedAt: vi.fn(),
    findNudgeCandidates: vi.fn(),
    setNudgeSentAt: vi.fn(),
    findAllByEmail: vi.fn(),
    deleteByEmail: vi.fn(),
    findSheetsSyncCandidates: vi.fn().mockResolvedValue([]),
    setSheetsSyncedAt: vi.fn(),
    countNeverSynced: vi.fn().mockResolvedValue(0),
    listByTenantKey: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn().mockResolvedValue(null),
  };
  const estimates: EstimateStore = {
    save: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    setNarrative: vi.fn().mockResolvedValue(false),
    findByAddressKey: vi.fn().mockResolvedValue([]),
  };
  const sheets: SheetsClient = {
    upsertRows: vi.fn().mockResolvedValue(undefined),
    checkAccess: vi.fn().mockResolvedValue(undefined),
  };
  const { store: syncState, getState: getSyncState } = makeSyncStateStore();
  // admin/05: durable run history. In-memory fake of SheetsSyncRunStore.
  const runs: SheetsSyncRunStore = {
    startRun: vi
      .fn()
      .mockImplementation(
        async (args: { trigger: 'timer' | 'manual'; actorEmail?: string | null }) =>
          ({
            id: `run-${args.trigger}`,
            startedAt: new Date(),
            finishedAt: null,
            trigger: args.trigger,
            actorEmail: args.actorEmail ?? null,
            status: 'running' as const,
            syncedCount: 0,
            skippedCount: 0,
            errorMessage: null,
          }),
      ),
    finishRun: vi.fn().mockResolvedValue(undefined),
    recent: vi.fn().mockResolvedValue([]),
    totalSyncedRows: vi.fn().mockResolvedValue(0),
    findInFlight: vi.fn().mockResolvedValue(null),
  };
  const deps: SheetsSyncServiceDeps = {
    leads,
    estimates,
    sheets,
    syncState,
    runs,
    enabled: true,
    maxLeadsPerRun: 500,
    ...overrides,
  };
  return { leads, estimates, sheets, syncState, getSyncState, runs, deps };
}

describe('SheetsSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when disabled (fail-closed)', async () => {
    const { deps, sheets, leads } = makeDeps({ enabled: false });
    const service = createSheetsSyncService(deps);
    const result = await service.runSyncCycle();
    expect(result.disabled).toBe(true);
    expect(result.synced).toBe(0);
    expect(sheets.upsertRows).not.toHaveBeenCalled();
    expect(leads.findSheetsSyncCandidates).not.toHaveBeenCalled();
  });

  it('upserts new leads and stamps the watermark', async () => {
    const lead = makeLead();
    const { deps, leads, sheets } = makeDeps();
    vi.mocked(leads.findSheetsSyncCandidates).mockResolvedValue([lead]);
    vi.mocked(leads.findById).mockResolvedValue(lead);
    vi.mocked(leads.setSheetsSyncedAt).mockImplementation(async (args) => ({
      ...lead,
      sheetsSyncedAt: args.at,
    }));

    const service = createSheetsSyncService(deps);
    const result = await service.runSyncCycle();

    expect(result.synced).toBe(1);
    expect(result.skipped).toBe(0);
    expect(sheets.upsertRows).toHaveBeenCalledTimes(1);
    const rows = vi.mocked(sheets.upsertRows).mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].leadId).toBe('lead-1');
    expect(rows[0].email).toBe('test@example.com');
    // Watermark stamped.
    expect(leads.setSheetsSyncedAt).toHaveBeenCalledWith({
      id: 'lead-1',
      at: expect.any(Date),
    });
  });

  it('maps lead fields to the correct Sheet columns', async () => {
    const lead = makeLead({
      name: 'Jane Doe',
      phone: null,
      tenantKey: 'elite-craft',
    });
    const { deps, leads, sheets } = makeDeps();
    vi.mocked(leads.findSheetsSyncCandidates).mockResolvedValue([lead]);
    vi.mocked(leads.findById).mockResolvedValue(lead);

    const service = createSheetsSyncService(deps);
    await service.runSyncCycle();

    const rows: readonly SheetLeadRow[] = vi.mocked(sheets.upsertRows).mock
      .calls[0][0];
    expect(rows[0]).toMatchObject({
      leadId: 'lead-1',
      name: 'Jane Doe',
      phone: '', // null → empty string
      tenant: 'elite-craft',
      marketingConsent: true,
    });
  });

  it('skips leads whose estimate is gone (erasure raced us)', async () => {
    const lead = makeLead();
    const { deps, leads, sheets } = makeDeps();
    vi.mocked(leads.findSheetsSyncCandidates).mockResolvedValue([lead]);
    // findById returns null (lead was erased between candidate scan and row build).
    vi.mocked(leads.findById).mockResolvedValue(null);

    const service = createSheetsSyncService(deps);
    const result = await service.runSyncCycle();

    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(1);
    expect(sheets.upsertRows).not.toHaveBeenCalled();
  });

  it('one bad lead does not kill the batch', async () => {
    const goodLead = makeLead({ id: 'good' });
    const badLead = makeLead({ id: 'bad' });
    const { deps, leads, sheets } = makeDeps();
    vi.mocked(leads.findSheetsSyncCandidates).mockResolvedValue([
      goodLead,
      badLead,
    ]);
    vi.mocked(leads.findById).mockImplementation(async (id) => {
      if (id === 'bad') throw new Error('DB error');
      return goodLead;
    });

    const service = createSheetsSyncService(deps);
    const result = await service.runSyncCycle();

    expect(result.synced).toBe(1);
    expect(result.skipped).toBe(1);
    expect(sheets.upsertRows).toHaveBeenCalledTimes(1);
  });

  it('retries transient Sheets API failures with backoff', async () => {
    const lead = makeLead();
    const sleepCalls: number[] = [];
    const { deps, leads, sheets } = makeDeps({
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1000 },
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    });
    vi.mocked(leads.findSheetsSyncCandidates).mockResolvedValue([lead]);
    vi.mocked(leads.findById).mockResolvedValue(lead);
    // Fail twice, then succeed.
    vi.mocked(sheets.upsertRows)
      .mockRejectedValueOnce(new Error('Rate limited'))
      .mockRejectedValueOnce(new Error('Rate limited'))
      .mockResolvedValueOnce(undefined);

    const service = createSheetsSyncService(deps);
    const result = await service.runSyncCycle();

    expect(result.synced).toBe(1);
    expect(result.consecutiveFailures).toBe(0);
    expect(sheets.upsertRows).toHaveBeenCalledTimes(3);
    // Exponential backoff: 1000ms, 2000ms.
    expect(sleepCalls).toEqual([1000, 2000]);
  });

  it('gives up after max attempts and counts as a cycle failure', async () => {
    const lead = makeLead();
    const { deps, leads, sheets } = makeDeps({
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0 },
      sleep: async () => {},
    });
    vi.mocked(leads.findSheetsSyncCandidates).mockResolvedValue([lead]);
    vi.mocked(leads.findById).mockResolvedValue(lead);
    vi.mocked(sheets.upsertRows).mockRejectedValue(new Error('Persistent failure'));

    const service = createSheetsSyncService(deps);
    await expect(service.runSyncCycle()).rejects.toThrow('Persistent failure');
    expect(sheets.upsertRows).toHaveBeenCalledTimes(2);
  });

  it('fires onSyncLagging after 3 consecutive failures', async () => {
    const onSyncLagging = vi.fn().mockResolvedValue(undefined);
    const lead = makeLead();
    // Disable retry delays for test speed; single attempt per cycle.
    const { deps, leads, sheets } = makeDeps({
      onSyncLagging,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
      sleep: async () => {},
    });
    vi.mocked(leads.findSheetsSyncCandidates).mockResolvedValue([lead]);
    vi.mocked(leads.findById).mockResolvedValue(lead);
    vi.mocked(sheets.upsertRows).mockRejectedValue(new Error('Sheets API down'));

    const service = createSheetsSyncService(deps);

    // First two failures: no alert yet.
    await expect(service.runSyncCycle()).rejects.toThrow('Sheets API down');
    await expect(service.runSyncCycle()).rejects.toThrow('Sheets API down');
    expect(onSyncLagging).not.toHaveBeenCalled();

    // Third consecutive failure: alert fires.
    await expect(service.runSyncCycle()).rejects.toThrow('Sheets API down');
    expect(onSyncLagging).toHaveBeenCalledTimes(1);
    expect(onSyncLagging).toHaveBeenCalledWith({
      consecutiveFailures: 3,
      firstFailureAt: expect.any(Date),
    });
  });

  it('resets the failure counter on success and fires onSyncRecovered', async () => {
    const onSyncLagging = vi.fn().mockResolvedValue(undefined);
    const onSyncRecovered = vi.fn().mockResolvedValue(undefined);
    const lead = makeLead();
    const { deps, sheets, leads } = makeDeps({
      onSyncLagging,
      onSyncRecovered,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
      sleep: async () => {},
    });
    vi.mocked(leads.findSheetsSyncCandidates).mockResolvedValue([lead]);
    vi.mocked(leads.findById).mockResolvedValue(lead);
    vi.mocked(sheets.upsertRows).mockRejectedValue(new Error('Sheets API down'));

    const service = createSheetsSyncService(deps);

    // 3 failures → lagging.
    await expect(service.runSyncCycle()).rejects.toThrow();
    await expect(service.runSyncCycle()).rejects.toThrow();
    await expect(service.runSyncCycle()).rejects.toThrow();
    expect(onSyncLagging).toHaveBeenCalledTimes(1);

    // Success → recovered.
    vi.mocked(sheets.upsertRows).mockResolvedValue(undefined);
    vi.mocked(leads.findSheetsSyncCandidates).mockResolvedValue([]);
    const result = await service.runSyncCycle();
    expect(result.consecutiveFailures).toBe(0);
    expect(onSyncRecovered).toHaveBeenCalledTimes(1);
  });

  it('persists the lagging metric in sync state (AC4)', async () => {
    const onSyncLagging = vi.fn().mockResolvedValue(undefined);
    const onSyncRecovered = vi.fn().mockResolvedValue(undefined);
    const lead = makeLead();
    const { deps, leads, sheets, getSyncState } = makeDeps({
      onSyncLagging,
      onSyncRecovered,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
      sleep: async () => {},
    });
    vi.mocked(leads.findSheetsSyncCandidates).mockResolvedValue([lead]);
    vi.mocked(leads.findById).mockResolvedValue(lead);
    vi.mocked(sheets.upsertRows).mockRejectedValue(new Error('Sheets API down'));

    const service = createSheetsSyncService(deps);

    // Not lagging before the 3rd failure.
    await expect(service.runSyncCycle()).rejects.toThrow();
    expect(getSyncState().lagging).toBe(false);
    expect(getSyncState().consecutiveFailures).toBe(1);

    await expect(service.runSyncCycle()).rejects.toThrow();
    expect(getSyncState().lagging).toBe(false);
    expect(getSyncState().consecutiveFailures).toBe(2);

    // 3rd failure → lagging=true, alert fires.
    await expect(service.runSyncCycle()).rejects.toThrow();
    expect(getSyncState().lagging).toBe(true);
    expect(getSyncState().consecutiveFailures).toBe(3);
    expect(getSyncState().firstFailureAt).toBeInstanceOf(Date);
    expect(onSyncLagging).toHaveBeenCalledTimes(1);

    // 4th failure → still lagging, alert NOT re-fired (one per streak).
    await expect(service.runSyncCycle()).rejects.toThrow();
    expect(getSyncState().lagging).toBe(true);
    expect(onSyncLagging).toHaveBeenCalledTimes(1);

    // Recovery clears the metric.
    vi.mocked(sheets.upsertRows).mockResolvedValue(undefined);
    vi.mocked(leads.findSheetsSyncCandidates).mockResolvedValue([]);
    const result = await service.runSyncCycle();
    expect(result.lagging).toBe(false);
    expect(getSyncState().lagging).toBe(false);
    expect(getSyncState().consecutiveFailures).toBe(0);
    expect(getSyncState().lastSuccessAt).toBeInstanceOf(Date);
    expect(onSyncRecovered).toHaveBeenCalledTimes(1);
  });

  it('tracks rows_synced_total across cycles for the status view', async () => {
    const lead = makeLead();
    const { deps, leads, sheets, getSyncState } = makeDeps();
    vi.mocked(leads.findSheetsSyncCandidates).mockResolvedValue([lead]);
    vi.mocked(leads.findById).mockResolvedValue(lead);

    const service = createSheetsSyncService(deps);
    await service.runSyncCycle();
    expect(getSyncState().rowsSyncedTotal).toBe(1);
    expect(getSyncState().lastRunAt).toBeInstanceOf(Date);
    expect(getSyncState().lastSuccessAt).toBeInstanceOf(Date);

    await service.runSyncCycle();
    expect(getSyncState().rowsSyncedTotal).toBe(2);
  });
});
