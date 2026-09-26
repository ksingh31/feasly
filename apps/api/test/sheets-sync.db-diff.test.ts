/**
 * admin/04 AC3 — zero writes to `leads` except the watermark.
 *
 * Runs a real sync cycle against PGlite with the real Drizzle lead store
 * and a fake Sheets client, then diffs the full `leads` row before/after.
 * The ONLY column allowed to change is `sheets_synced_at`. (The
 * `leads_set_updated_at()` trigger preserves `updated_at` when just the
 * watermark is stamped, so it must not change either.)
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { leads, estimates } from '../src/db/schema';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createDrizzleSheetsSyncStateStore } from '../src/services/sheets-sync-state.store';
import { createDrizzleSheetsSyncRunStore } from '../src/services/sheets-sync-run.store';
import { createSheetsSyncService } from '../src/services/sheets-sync.service';
import type { EstimateStore } from '../src/services/estimate.store';
import type { SheetsClient } from '../src/services/sheets/sheets-client';
import { createTestDb, type TestDb } from './pglite-db';

describe('sheets sync — zero writes to leads except the watermark (AC3)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('only sheets_synced_at changes on the leads row', async () => {
    const estimateId = randomUUID();
    const leadId = randomUUID();

    await testDb.db.insert(estimates).values({
      id: estimateId,
      projectType: 'new_build',
      addressKey: '123 Main St Calgary',
      inputs: { sqft: 2100, tier: 'mid', garage: 'double' },
      figures: { total: { low: 500000, high: 600000 } },
      rows: [],
      costDataVersion: 'test',
    });
    await testDb.db.insert(leads).values({
      id: leadId,
      estimateId,
      addressKey: '123 Main St Calgary',
      email: 'diff-test@example.com',
      name: 'Diff Test',
      phone: '403-555-0100',
      timeline: '3-6 months',
      marketingConsent: true,
      consentTs: new Date('2026-09-25T00:00:00Z'),
      source: 'web',
      leadScore: 75,
      status: 'new',
    });

    const before = (
      await testDb.db.select().from(leads).where(eq(leads.id, leadId))
    )[0];
    expect(before).toBeDefined();
    expect(before.sheetsSyncedAt).toBeNull();

    // Real lead store + real sync-state store; fake Sheets + fake estimates
    // (the estimate join is not what this test exercises).
    const leadStore = createDrizzleLeadStore({ db: testDb.db });
    const syncState = createDrizzleSheetsSyncStateStore({ db: testDb.db });
    const runs = createDrizzleSheetsSyncRunStore({ db: testDb.db });
    const estimateStore: EstimateStore = {
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
    const sheets: SheetsClient = {
      upsertRows: vi.fn().mockResolvedValue(undefined),
      checkAccess: vi.fn().mockResolvedValue(undefined),
    };

    const service = createSheetsSyncService({
      leads: leadStore,
      estimates: estimateStore,
      sheets,
      syncState,
      runs,
      enabled: true,
      maxLeadsPerRun: 500,
    });
    const result = await service.runSyncCycle();
    expect(result.synced).toBe(1);
    expect(sheets.upsertRows).toHaveBeenCalledTimes(1);

    const after = (
      await testDb.db.select().from(leads).where(eq(leads.id, leadId))
    )[0];
    expect(after).toBeDefined();

    // The watermark was stamped.
    expect(after.sheetsSyncedAt).toBeInstanceOf(Date);

    // Every other column is byte-identical.
    const { sheetsSyncedAt: _beforeWatermark, ...beforeRest } = before;
    const { sheetsSyncedAt: _afterWatermark, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
  });

  it('does not touch leads at all when Sheets is disabled', async () => {
    const estimateId = randomUUID();
    const leadId = randomUUID();
    await testDb.db.insert(estimates).values({
      id: estimateId,
      projectType: 'new_build',
      addressKey: '456 Main St Calgary',
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'test',
    });
    await testDb.db.insert(leads).values({
      id: leadId,
      estimateId,
      addressKey: '456 Main St Calgary',
      email: 'disabled-test@example.com',
      name: 'Disabled Test',
      timeline: '3-6 months',
      consentTs: new Date('2026-09-25T00:00:00Z'),
    });

    const before = (
      await testDb.db.select().from(leads).where(eq(leads.id, leadId))
    )[0];

    const leadStore = createDrizzleLeadStore({ db: testDb.db });
    const syncState = createDrizzleSheetsSyncStateStore({ db: testDb.db });
    const runs = createDrizzleSheetsSyncRunStore({ db: testDb.db });
    const service = createSheetsSyncService({
      leads: leadStore,
      estimates: {} as EstimateStore,
      sheets: {} as SheetsClient,
      syncState,
      runs,
      enabled: false,
      maxLeadsPerRun: 500,
    });
    const result = await service.runSyncCycle();
    expect(result.disabled).toBe(true);

    const after = (
      await testDb.db.select().from(leads).where(eq(leads.id, leadId))
    )[0];
    expect(after).toEqual(before);
  });
});
