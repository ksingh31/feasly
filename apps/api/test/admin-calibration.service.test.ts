/**
 * Admin calibration-console service tests (admin/09).
 *
 * Tests the service layer with the real placeholder cost-data:
 * - AC1: console shows the frozen v1 version + report from the real
 *   calibration import (integration test with fixture data). Until the
 *   import lands, the report honestly shows the uncalibrated state.
 * - AC2: no inline param editing exists anywhere (no write methods on
 *   the service interface).
 * - AC3: "start v2 import" creates a draft, never touching frozen v1
 *   (hasDraftV2 flag is isolated from the frozen version).
 * - AC4: admin-auth required (enforced in the route; service receives
 *   the verified admin email).
 */
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import {
  createAdminCalibrationService,
  NO_CALIBRATION_WARNING,
  SMALL_SAMPLE_WARNING,
  SMALL_SAMPLE_THRESHOLD,
} from '../src/services/admin-calibration.service';
import type { CalibrationImportHistoryItem } from '@feasly/contracts';

const ADMIN_EMAIL = 'karanbirsingh667@gmail.com';

describe('admin-calibration.service', () => {
  it('AC1: reports the current cost-data version honestly (uncalibrated placeholder)', async () => {
    const service = createAdminCalibrationService({
      costData: PLACEHOLDER_COST_DATA,
    });
    const res = await service.getCalibration(ADMIN_EMAIL);

    expect(res.current.version).toBe(PLACEHOLDER_COST_DATA.version);
    expect(res.current.calibrated).toBe(false);
    expect(res.current.frozen).toBe(false);
    expect(res.current.source).toContain('placeholder');
    expect(res.current.hardCostCategories).toBeGreaterThan(0);
    expect(res.current.softCostCategories).toBeGreaterThan(0);
    expect(res.current.tiers.length).toBeGreaterThan(0);
  });

  it('AC1: report shows zero houses + no-calibration warning until the import lands', async () => {
    const service = createAdminCalibrationService({
      costData: PLACEHOLDER_COST_DATA,
    });
    const res = await service.getCalibration(ADMIN_EMAIL);

    expect(res.report.costDataVersion).toBe(PLACEHOLDER_COST_DATA.version);
    expect(res.report.houses).toEqual([]);
    expect(res.report.sampleSize).toBe(0);
    expect(res.report.smallSampleWarning).toBe(NO_CALIBRATION_WARNING);
    expect(res.report.meanAbsoluteErrorFraction).toBeNull();
  });

  it('AC1: import history is empty until the first calibration import', async () => {
    const service = createAdminCalibrationService({
      costData: PLACEHOLDER_COST_DATA,
    });
    const res = await service.getCalibration(ADMIN_EMAIL);

    expect(res.importHistory).toEqual([]);
    expect(res.hasDraftV2).toBe(false);
  });

  it('AC1: surfaces import history newest-first when the import tooling provides it', async () => {
    const history: CalibrationImportHistoryItem[] = [
      {
        id: 'import-2',
        importedAt: '2026-10-02T00:00:00.000Z',
        version: 'v1.0.0-calgary',
        houseCount: 4,
        importedBy: ADMIN_EMAIL,
        status: 'frozen',
      },
      {
        id: 'import-1',
        importedAt: '2026-10-01T00:00:00.000Z',
        version: 'v0.9.0-draft',
        houseCount: 3,
        importedBy: ADMIN_EMAIL,
        status: 'superseded',
      },
    ];
    const service = createAdminCalibrationService({
      costData: PLACEHOLDER_COST_DATA,
      importHistory: history,
    });
    const res = await service.getCalibration(ADMIN_EMAIL);

    expect(res.importHistory).toEqual(history);
    expect(res.importHistory[0].status).toBe('frozen');
  });

  it('AC2: the service exposes no write methods (read-only by design)', () => {
    const service = createAdminCalibrationService({
      costData: PLACEHOLDER_COST_DATA,
    });
    // Only getCalibration exists — no updateParams, no freeze, no import.
    expect(Object.keys(service)).toEqual(['getCalibration']);
  });

  it('AC3: a v2 draft is flagged without touching the frozen v1', async () => {
    const service = createAdminCalibrationService({
      costData: PLACEHOLDER_COST_DATA,
      hasDraftV2: true,
    });
    const res = await service.getCalibration(ADMIN_EMAIL);

    expect(res.hasDraftV2).toBe(true);
    // The current (v1) version info is untouched by the draft flag.
    expect(res.current.version).toBe(PLACEHOLDER_COST_DATA.version);
    expect(res.current.frozen).toBe(false);
  });

  it('small-sample constants are sane', () => {
    expect(SMALL_SAMPLE_THRESHOLD).toBe(10);
    expect(SMALL_SAMPLE_WARNING).toContain('Small sample warning');
    expect(NO_CALIBRATION_WARNING).toContain('No calibration data yet');
  });
});
