/**
 * FE6-004 spec: neighbourhood lot price sampling.
 *
 * Fixture-based coverage for sample filtering (vacant + teardown),
 * the 5-sample fallback threshold, average math, the 10-sample cap
 * with vacant priority, config validation, and determinism.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOT_SAMPLING_CONFIG,
  filterLotSamples,
  isExcludedDesignation,
  loadLotSamplingConfig,
  mergeLotSamples,
  teardownLotsWhere,
  vacantLotsWhere,
  type LotSample,
  type LotSamplingConfig,
  type RawLotRow,
} from './community-lot-sampling.js';

const CONFIG: LotSamplingConfig = { cap: 10, min: 5, ageYears: 30 };
const CURRENT_YEAR = 2026;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function vacantRow(overrides: Partial<RawLotRow> = {}): RawLotRow {
  return {
    address: '123 TEST ST NW',
    assessed_value: 700000,
    land_size_sf: 5000,
    land_use_designation: 'R-C2',
    property_type: 'LO',
    assessment_class: 'RE',
    ...overrides,
  };
}

function teardownRow(overrides: Partial<RawLotRow> = {}): RawLotRow {
  return {
    address: '456 OLD AV SE',
    assessed_value: 800000,
    land_size_sf: 6000,
    land_use_designation: 'R-C1',
    year_of_construction: 1960,
    property_type: 'LI',
    assessment_class: 'RE',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isExcludedDesignation
// ---------------------------------------------------------------------------
describe('isExcludedDesignation', () => {
  it('excludes multi-unit designations', () => {
    expect(isExcludedDesignation('MU-1')).toBe(true);
    expect(isExcludedDesignation('MU-2')).toBe(true);
    expect(isExcludedDesignation('M-C2')).toBe(true);
    expect(isExcludedDesignation('M-H1')).toBe(true);
  });

  it('excludes commercial and industrial', () => {
    expect(isExcludedDesignation('C-COR1')).toBe(true);
    expect(isExcludedDesignation('I-B')).toBe(true);
  });

  it('keeps residential designations', () => {
    expect(isExcludedDesignation('R-C1')).toBe(false);
    expect(isExcludedDesignation('R-C2')).toBe(false);
    expect(isExcludedDesignation('R-CG')).toBe(false);
    expect(isExcludedDesignation('H-GO')).toBe(false);
  });

  it('is case-insensitive and handles null', () => {
    expect(isExcludedDesignation('mu-1')).toBe(true);
    expect(isExcludedDesignation(null)).toBe(false);
    expect(isExcludedDesignation(undefined)).toBe(false);
    expect(isExcludedDesignation('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterLotSamples — vacant
// ---------------------------------------------------------------------------
describe('filterLotSamples (vacant)', () => {
  it('accepts a valid vacant lot', () => {
    const samples = filterLotSamples([vacantRow()], 'vacant', CONFIG, CURRENT_YEAR);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      address: '123 TEST ST NW',
      assessedValue: 700000,
      kind: 'vacant',
    });
  });

  it('excludes tiny remnant parcels (< 1000 sqft)', () => {
    const rows = [
      vacantRow({ address: 'A', land_size_sf: 852 }),
      vacantRow({ address: 'B', land_size_sf: 999 }),
      vacantRow({ address: 'C', land_size_sf: 1000 }),
    ];
    const samples = filterLotSamples(rows, 'vacant', CONFIG, CURRENT_YEAR);
    expect(samples.map((s) => s.address)).toEqual(['C']);
  });

  it('allows null lot size (unknown)', () => {
    const samples = filterLotSamples(
      [vacantRow({ land_size_sf: null })],
      'vacant',
      CONFIG,
      CURRENT_YEAR,
    );
    expect(samples).toHaveLength(1);
  });

  it('excludes multi-unit designations', () => {
    const rows = [
      vacantRow({ address: 'A', land_use_designation: 'MU-1' }),
      vacantRow({ address: 'B', land_use_designation: 'R-C2' }),
    ];
    const samples = filterLotSamples(rows, 'vacant', CONFIG, CURRENT_YEAR);
    expect(samples.map((s) => s.address)).toEqual(['B']);
  });

  it('excludes rows with missing address or non-positive value', () => {
    const rows = [
      vacantRow({ address: '' }),
      vacantRow({ address: 'B', assessed_value: 0 }),
      vacantRow({ address: 'C', assessed_value: -100 }),
      vacantRow({ address: 'D', assessed_value: null }),
    ];
    expect(filterLotSamples(rows, 'vacant', CONFIG, CURRENT_YEAR)).toHaveLength(0);
  });

  it('sorts by assessed value ascending, deterministically', () => {
    const rows = [
      vacantRow({ address: 'C', assessed_value: 900000 }),
      vacantRow({ address: 'A', assessed_value: 700000 }),
      vacantRow({ address: 'B', assessed_value: 700000 }),
    ];
    const samples = filterLotSamples(rows, 'vacant', CONFIG, CURRENT_YEAR);
    expect(samples.map((s) => s.address)).toEqual(['A', 'B', 'C']);
  });
});

// ---------------------------------------------------------------------------
// filterLotSamples — teardown
// ---------------------------------------------------------------------------
describe('filterLotSamples (teardown)', () => {
  it('accepts houses at or beyond the age threshold', () => {
    const rows = [
      teardownRow({ address: 'A', assessed_value: 900000, year_of_construction: 1996 }), // exactly 30 years
      teardownRow({ address: 'B', assessed_value: 700000, year_of_construction: 1950 }),
    ];
    const samples = filterLotSamples(rows, 'teardown', CONFIG, CURRENT_YEAR);
    expect(samples.map((s) => s.address)).toEqual(['B', 'A']);
  });

  it('excludes newer houses', () => {
    const rows = [
      teardownRow({ address: 'A', year_of_construction: 1997 }), // 29 years
      teardownRow({ address: 'B', year_of_construction: 2015 }),
      teardownRow({ address: 'C', year_of_construction: null }),
    ];
    expect(filterLotSamples(rows, 'teardown', CONFIG, CURRENT_YEAR)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mergeLotSamples
// ---------------------------------------------------------------------------
function sample(address: string, assessedValue: number, kind: 'vacant' | 'teardown'): LotSample {
  return { address, assessedValue, lotSqft: 5000, kind };
}

describe('mergeLotSamples', () => {
  it('prefers vacant lots and caps at cap', () => {
    const vacant = Array.from({ length: 8 }, (_, i) => sample(`V${i}`, 700000 + i, 'vacant'));
    const teardown = Array.from({ length: 8 }, (_, i) => sample(`T${i}`, 800000 + i, 'teardown'));
    const result = mergeLotSamples(vacant, teardown, CONFIG, 650000);
    expect(result.lotPriceSource).toBe('sampled-lots');
    expect(result.lotSampleCount).toBe(10);
    // All 8 vacant + first 2 teardown
    expect(result.sampleAddresses).toHaveLength(10);
    expect(result.sampleAddresses.slice(0, 8).every((a) => a.startsWith('V'))).toBe(true);
  });

  it('falls back to community average below min', () => {
    const vacant = [sample('V1', 700000, 'vacant'), sample('V2', 710000, 'vacant')];
    const teardown = [sample('T1', 800000, 'teardown'), sample('T2', 810000, 'teardown')];
    const result = mergeLotSamples(vacant, teardown, CONFIG, 650000);
    expect(result).toEqual({
      lotSampleAverage: 650000,
      lotSampleCount: 0,
      lotPriceSource: 'community-average',
      sampleAddresses: [],
    });
  });

  it('samples at exactly min', () => {
    const vacant = Array.from({ length: 5 }, (_, i) => sample(`V${i}`, 700000, 'vacant'));
    const result = mergeLotSamples(vacant, [], CONFIG, 650000);
    expect(result.lotPriceSource).toBe('sampled-lots');
    expect(result.lotSampleCount).toBe(5);
    expect(result.lotSampleAverage).toBe(700000);
  });

  it('computes the exact integer average', () => {
    const vacant = [
      sample('A', 700000, 'vacant'),
      sample('B', 700001, 'vacant'),
      sample('C', 700002, 'vacant'),
      sample('D', 700003, 'vacant'),
      sample('E', 700004, 'vacant'),
    ];
    const result = mergeLotSamples(vacant, [], CONFIG, 0);
    // (700000+700001+700002+700003+700004)/5 = 700002
    expect(result.lotSampleAverage).toBe(700002);
  });

  it('rounds the average to an integer', () => {
    const vacant = [
      sample('A', 700000, 'vacant'),
      sample('B', 700000, 'vacant'),
      sample('C', 700000, 'vacant'),
      sample('D', 700000, 'vacant'),
      sample('E', 700001, 'vacant'),
    ];
    const result = mergeLotSamples(vacant, [], CONFIG, 0);
    // 3500001/5 = 700000.2 → 700000
    expect(result.lotSampleAverage).toBe(700000);
  });

  it('is deterministic on repeated runs', () => {
    const vacant = Array.from({ length: 7 }, (_, i) => sample(`V${i}`, 700000 + i * 1000, 'vacant'));
    const teardown = Array.from({ length: 7 }, (_, i) => sample(`T${i}`, 800000 + i * 1000, 'teardown'));
    const a = mergeLotSamples(vacant, teardown, CONFIG, 650000);
    const b = mergeLotSamples(vacant, teardown, CONFIG, 650000);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// SoQL WHERE builders
// ---------------------------------------------------------------------------
describe('where builders', () => {
  it('vacantLotsWhere filters to land-only residential', () => {
    const where = vacantLotsWhere('ALTADORE');
    expect(where).toContain("comm_name='ALTADORE'");
    expect(where).toContain("property_type='LO'");
    expect(where).toContain("assessment_class='RE'");
  });

  it('escapes single quotes in community names', () => {
    const where = vacantLotsWhere("O'BRIEN");
    expect(where).toContain("comm_name='O''BRIEN'");
  });

  it('teardownLotsWhere applies the age cutoff', () => {
    const where = teardownLotsWhere('ALTADORE', 30, 2026);
    expect(where).toContain('year_of_construction <= 1996');
    expect(where).toContain("property_type='LI'");
  });
});

// ---------------------------------------------------------------------------
// loadLotSamplingConfig
// ---------------------------------------------------------------------------
describe('loadLotSamplingConfig', () => {
  it('uses defaults when env is empty', () => {
    expect(loadLotSamplingConfig({})).toEqual(DEFAULT_LOT_SAMPLING_CONFIG);
  });

  it('reads all three vars', () => {
    const config = loadLotSamplingConfig({
      LOT_SAMPLE_CAP: '8',
      LOT_SAMPLE_MIN: '3',
      LOT_SAMPLE_AGE_YEARS: '25',
    });
    expect(config).toEqual({ cap: 8, min: 3, ageYears: 25 });
  });

  it('rejects non-numeric values', () => {
    expect(() => loadLotSamplingConfig({ LOT_SAMPLE_CAP: 'many' })).toThrow(/LOT_SAMPLE_CAP/);
    expect(() => loadLotSamplingConfig({ LOT_SAMPLE_MIN: '0' })).toThrow(/LOT_SAMPLE_MIN/);
    expect(() => loadLotSamplingConfig({ LOT_SAMPLE_AGE_YEARS: '-5' })).toThrow(/LOT_SAMPLE_AGE_YEARS/);
  });

  it('rejects min > cap', () => {
    expect(() =>
      loadLotSamplingConfig({ LOT_SAMPLE_CAP: '5', LOT_SAMPLE_MIN: '6' }),
    ).toThrow(/must not exceed/);
  });
});
