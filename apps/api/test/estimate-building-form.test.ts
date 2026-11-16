/**
 * #689 — building-form choice on new-build estimates.
 *
 * - `buildingForm` omitted behaves exactly as before (AC3).
 * - An unpriced form returns the typed error envelope, never a figure (AC4).
 * - A covered district that does not list the form refuses it; unknown and
 *   Direct Control districts fail open with a warning (AC2).
 * - The requested form is stored on the estimate snapshot.
 */
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import { createEstimateService } from '../src/services/estimate.service';
import type { EstimateRecord, EstimateStore } from '../src/services/estimate.store';
import { createZoningService } from '../src/services/zoning.service';
import { expectEstimateResponse, mockCommunityStatsService } from './helpers/mock-community-stats';

function body(zoning: string, buildingForm?: string): Record<string, unknown> {
  return {
    property: {
      addressKey: 'calgary-123-fake-st-nw',
      assessedLandValue: 450_000,
      lotSizeSqft: 5_000,
      zoning,
    },
    scope:
      buildingForm === undefined
        ? { buildSqft: 2_200, tier: 'premium' }
        : { buildSqft: 2_200, tier: 'premium', buildingForm },
  };
}

function setup(withZoning = true): {
  service: ReturnType<typeof createEstimateService>;
  saved: EstimateRecord[];
  warnings: string[];
} {
  const saved: EstimateRecord[] = [];
  const warnings: string[] = [];
  const store: EstimateStore = {
    save: async (r) => {
      saved.push(r);
    },
    findById: async () => null,
    setNarrative: async () => false,
    findByAddressKey: async () => [],
  };
  const service = createEstimateService({
    costData: PLACEHOLDER_COST_DATA,
    store,
    allowDraftCostData: true,
    communityStats: mockCommunityStatsService(),
    ...(withZoning ? { zoning: createZoningService({ config: { city: 'calgary' } }) } : {}),
    logWarning: (m) => warnings.push(m),
  });
  return { service, saved, warnings };
}

async function rejection(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

/** Strip the per-request fields so two responses can be compared. */
function stable(r: unknown): unknown {
  const { estimateId: _id, createdAt: _at, ...rest } = r as Record<string, unknown>;
  return rest;
}

describe('#689 building form on new-build estimates', () => {
  it('omitted form: identical response to before, stored as null, no check run (AC3)', async () => {
    const withZoning = setup();
    const without = setup(false);
    const a = expectEstimateResponse(await withZoning.service.estimate(body('R-C1')));
    const b = expectEstimateResponse(await without.service.estimate(body('R-C1')));
    expect(stable(a)).toEqual(stable(b));
    expect(a.inputs).toEqual({ sqft: 2_200, tier: 'premium', garage: 'none', basement: 'unfinished' });
    expect(withZoning.saved[0]?.buildingForm).toBeNull();
    expect(withZoning.warnings).toEqual([]);
  });

  it('omitted form on a district that lists no single-detached still prices (no new block)', async () => {
    const { service } = setup();
    // M-C1-style districts: legacy requests never get a building-form check.
    expect(expectEstimateResponse(await service.estimate(body('CC-X'))).figures.build.low).toBeGreaterThan(0);
  });

  it('explicit single-detached: same figures as omitted, form stored on the snapshot', async () => {
    const { service, saved } = setup();
    const omitted = expectEstimateResponse(await service.estimate(body('R-C1')));
    const explicit = expectEstimateResponse(await service.estimate(body('R-C1', 'single-detached')));
    expect(stable(explicit)).toEqual(stable(omitted));
    expect(saved[1]?.buildingForm).toBe('single-detached');
  });

  it('unpriced form on a district that allows it → 400 BUILDING_FORM_NOT_PRICED, nothing saved (AC4)', async () => {
    const { service, saved } = setup();
    const err = await rejection(service.estimate(body('R-C2', 'semi-detached')));
    expect(err.status).toBe(400);
    expect(err.code).toBe(ErrorCodes.BUILDING_FORM_NOT_PRICED);
    expect(err.message).not.toMatch(/\$|\d/);
    expect(saved).toHaveLength(0);
  });

  it('form the covered district does not list → 400 BUILDING_FORM_NOT_ALLOWED', async () => {
    const { service, saved } = setup();
    const err = await rejection(service.estimate(body('R-C1', 'semi-detached')));
    expect(err.status).toBe(400);
    expect(err.code).toBe(ErrorCodes.BUILDING_FORM_NOT_ALLOWED);
    expect(saved).toHaveLength(0);
  });

  it.each(['DC', 'ZZ-UNKNOWN'])(
    '%s district: single-detached prices and nothing is blocked; a warning is logged (AC2)',
    async (zoning) => {
      const { service, saved, warnings } = setup();
      const res = expectEstimateResponse(await service.estimate(body(zoning, 'single-detached')));
      expect(res.figures.build.low).toBeGreaterThan(0);
      expect(saved[0]?.buildingForm).toBe('single-detached');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('not checked');
    },
  );

  it('unknown district + unpriced form is still refused by the engine (typed, no figure)', async () => {
    const { service } = setup();
    const err = await rejection(service.estimate(body('ZZ-UNKNOWN', 'rowhouse')));
    expect(err.code).toBe(ErrorCodes.BUILDING_FORM_NOT_PRICED);
  });

  it('a value outside the vocabulary is a plain validation error', async () => {
    const { service } = setup();
    const err = await rejection(service.estimate(body('R-C1', 'castle')));
    expect(err.status).toBe(400);
    expect(err.code).toBe(ErrorCodes.VALIDATION_FAILED);
  });
});
