/**
 * sheets-sync-timer adapter test (admin/04).
 *
 * Regression for the Sep 2026 silent Azure failure: the hourly timer DID
 * fire, but `runSyncCycle` threw on its very first DB write — the
 * `sheets_sync_runs` INSERT failed because dev Postgres had schema-drifted
 * (drizzle-kit silently skipped the table-creation migration). From the
 * outside the timer "never fired": no run rows, no sync, and the error was
 * visible only in App Insights.
 *
 * Unlike the service unit tests (which fake the run store), this test runs
 * the REAL adapter entry point with the REAL service + REAL Drizzle stores
 * against PGlite with the real migrations applied — so the exact failed
 * operation (the run-record INSERT) is exercised end to end.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createSheetsSyncService } from '../src/services/sheets-sync.service';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createDrizzleSheetsSyncStateStore } from '../src/services/sheets-sync-state.store';
import { createDrizzleSheetsSyncRunStore } from '../src/services/sheets-sync-run.store';
import type { EstimateStore } from '../src/services/estimate.store';
import type { SheetsClient } from '../src/services/sheets/sheets-client';
import { sheetsSyncRuns, leads, estimates } from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

// The adapter binds `createComposition` lazily via getApp(), but the module
// import itself must see the mocked barrel — same pattern as the nudge
// timer adapter test.
const fakeApp: { sheetsSyncService: unknown } = { sheetsSyncService: null };

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
}));

// Imported after the mock.
import { sheetsSyncTimerHandler } from '../src/functions/sheets-sync-timer';

function makeEstimateStore(estimateId: string): EstimateStore {
  return {
    save: vi.fn(),
    findById: vi.fn().mockResolvedValue({
      id: estimateId,
      projectType: 'new_build',
      inputs: { sqft: 2100, tier: 'mid' },
      figures: { total: { low: 500000, high: 600000 } },
    }),
    setNarrative: vi.fn().mockResolvedValue(false),
    findByAddressKey: vi.fn().mockResolvedValue([]),
  };
}

/** Mirrors composition.ts's disabled client: never called, throws if it is. */
function makeDisabledSheetsClient(): SheetsClient {
  const disabled = async (): Promise<never> => {
    throw new Error('Sheets sync is disabled (SHEETS_SHEET_ID not configured)');
  };
  return { upsertRows: disabled, checkAccess: disabled };
}

describe('sheets-sync-timer adapter', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  /**
   * The Sep 2026 Azure failure, reproduced: with Sheets unconfigured (the
   * dev/prod-placeholder state), the timer must still complete its cycle —
   * recording the run — instead of dying on the `sheets_sync_runs` INSERT.
   */
  it("records a 'disabled' run when Sheets is unconfigured (fail-closed)", async () => {
    const service = createSheetsSyncService({
      leads: createDrizzleLeadStore({ db: testDb.db }),
      estimates: makeEstimateStore(randomUUID()),
      sheets: makeDisabledSheetsClient(),
      syncState: createDrizzleSheetsSyncStateStore({ db: testDb.db }),
      runs: createDrizzleSheetsSyncRunStore({ db: testDb.db }),
      enabled: false,
      maxLeadsPerRun: 500,
    });
    fakeApp.sheetsSyncService = service;

    const logs: unknown[][] = [];
    const context = { log: (...args: unknown[]) => void logs.push(args) };

    // Must not throw: the Azure incident was exactly this call dying on
    // the run-record INSERT, leaving zero trace in the ops panel.
    await expect(
      sheetsSyncTimerHandler(context),
    ).resolves.toBeUndefined();

    const runRows = await testDb.db
      .select()
      .from(sheetsSyncRuns)
      .where(eq(sheetsSyncRuns.trigger, 'timer'));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]!.status).toBe('disabled');

    const line = String(logs[0]![0]);
    expect(line).toContain('fail-closed');
  });

  it('logs aggregate counts only — never PII', async () => {
    const estimateId = randomUUID();
    const leadId = randomUUID();
    await testDb.db.insert(estimates).values({
      id: estimateId,
      projectType: 'new_build',
      addressKey: '789 Test Ave Calgary',
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'test',
    });
    await testDb.db.insert(leads).values({
      id: leadId,
      estimateId,
      addressKey: '789 Test Ave Calgary',
      email: 'pii-check@example.com',
      name: 'PII Check',
      timeline: '3-6 months',
      consentTs: new Date('2026-09-25T00:00:00Z'),
    });

    const upsertRows = vi.fn().mockResolvedValue(undefined);
    const service = createSheetsSyncService({
      leads: createDrizzleLeadStore({ db: testDb.db }),
      estimates: makeEstimateStore(estimateId),
      sheets: {
        upsertRows,
        checkAccess: vi.fn().mockResolvedValue(undefined),
      },
      syncState: createDrizzleSheetsSyncStateStore({ db: testDb.db }),
      runs: createDrizzleSheetsSyncRunStore({ db: testDb.db }),
      enabled: true,
      maxLeadsPerRun: 500,
    });
    fakeApp.sheetsSyncService = service;

    const logs: unknown[][] = [];
    await sheetsSyncTimerHandler({
      log: (...args: unknown[]) => void logs.push(args),
    });

    const line = String(logs[0]![0]);
    expect(line).toContain('synced=1');
    // No email addresses, lead ids, or tokens in the log line.
    expect(line).not.toMatch(/@/);
    expect(line).not.toMatch(/lead-/);
    expect(line).not.toMatch(/token/);

    // The run history shows a successful timer cycle with the watermark stamped.
    const runRows = await testDb.db
      .select()
      .from(sheetsSyncRuns)
      .where(eq(sheetsSyncRuns.trigger, 'timer'))
      .orderBy(sheetsSyncRuns.startedAt);
    const latest = runRows[runRows.length - 1]!;
    expect(latest.status).toBe('success');
    expect(latest.syncedCount).toBe(1);

    const leadRows = await testDb.db
      .select()
      .from(leads)
      .where(eq(leads.id, leadId));
    expect(leadRows[0]!.sheetsSyncedAt).toBeInstanceOf(Date);
  });

  /**
   * The "silently broken" guard: if the cycle dies before recording a run
   * (the Sep 2026 incident — the `sheets_sync_runs` INSERT itself threw),
   * the adapter emits a structured, sanitized failure line for Azure
   * Monitor to alert on, then rethrows so the host records the invocation
   * failure and retries on schedule.
   */
  it('logs a structured CYCLE FAILED line and rethrows when the cycle throws', async () => {
    const boom = new Error('insert into "sheets_sync_runs" failed: boom');
    fakeApp.sheetsSyncService = {
      runSyncCycle: vi.fn().mockRejectedValue(boom),
    };

    const logs: unknown[][] = [];
    await expect(
      sheetsSyncTimerHandler({
        log: (...args: unknown[]) => void logs.push(args),
      }),
    ).rejects.toThrow('boom');

    const line = String(logs[0]![0]);
    expect(line).toContain('CYCLE FAILED');
    expect(line).toContain('boom');
  });
});
