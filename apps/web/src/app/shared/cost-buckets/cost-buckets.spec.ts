import { describe, expect, it } from 'vitest';
import type { CostRow } from '@feasly/contracts';
import { aggregateCostBuckets } from './cost-buckets';

function row(key: string, low: number, base: number, high: number): CostRow {
  return { key, label: key, range: { low, base, high } };
}

/** The mock-harness rows (mock-data.ts mockRows) with simple figures. */
const MOCK_ROWS: readonly CostRow[] = [
  row('site', 38, 42, 46),
  row('foundation', 62, 68, 74),
  row('framing', 118, 128, 138),
  row('envelope', 88, 96, 104),
  row('interior', 145, 158.5, 172),
  row('mechanical', 64, 71, 78),
  row('soft', 45, 51.5, 58),
  row('contingency', 50, 57.5, 65),
];

describe('aggregateCostBuckets', () => {
  it('maps the mock-harness keys to the three D-01 buckets with summed ranges', () => {
    const buckets = aggregateCostBuckets(MOCK_ROWS);
    expect(buckets.map((b) => b.key)).toEqual(['structure', 'interior', 'design']);
    expect(buckets.map((b) => b.label)).toEqual([
      'Structure & exterior',
      'Interior & home systems',
      'Design, permits & contingency',
    ]);
    expect(buckets[0].range).toEqual({ low: 38 + 62 + 118 + 88, base: 42 + 68 + 128 + 96, high: 46 + 74 + 138 + 104 });
    expect(buckets[1].range).toEqual({ low: 145 + 64, base: 158.5 + 71, high: 172 + 78 });
    expect(buckets[2].range).toEqual({ low: 45 + 50, base: 51.5 + 57.5, high: 58 + 65 });
  });

  it('maps the engine dot-notation keys per D-01', () => {
    const rows = [
      row('hard.framing', 1, 2, 3),
      row('hard.foundation', 1, 2, 3),
      row('hard.envelope', 1, 2, 3),
      row('hard.sitePrep', 1, 2, 3),
      row('hard.finishes', 10, 20, 30),
      row('hard.mep', 10, 20, 30),
      row('soft.design', 100, 200, 300),
      row('soft.permits', 100, 200, 300),
      row('contingency', 100, 200, 300),
    ];
    const buckets = aggregateCostBuckets(rows);
    expect(buckets[0].range).toEqual({ low: 4, base: 8, high: 12 });
    expect(buckets[1].range).toEqual({ low: 20, base: 40, high: 60 });
    expect(buckets[2].range).toEqual({ low: 300, base: 600, high: 900 });
  });

  it('excludes the land row (it renders as the separate fixed figure)', () => {
    const rows = [...MOCK_ROWS, row('land', 400000, 420000, 440000)];
    const buckets = aggregateCostBuckets(rows);
    const total = buckets.reduce((sum, b) => sum + b.range.base, 0);
    expect(total).toBeCloseTo(42 + 68 + 128 + 96 + 158.5 + 71 + 51.5 + 57.5, 10);
  });

  it('sends unmapped future rows to the "Design, permits & contingency" catch-all', () => {
    const buckets = aggregateCostBuckets([row('hard.somethingNew', 7, 8, 9)]);
    expect(buckets[0].range).toEqual({ low: 0, base: 0, high: 0 });
    expect(buckets[1].range).toEqual({ low: 0, base: 0, high: 0 });
    expect(buckets[2].range).toEqual({ low: 7, base: 8, high: 9 });
  });

  it('always returns all three buckets, even for empty input', () => {
    const buckets = aggregateCostBuckets([]);
    expect(buckets.length).toBe(3);
    for (const b of buckets) {
      expect(b.range).toEqual({ low: 0, base: 0, high: 0 });
    }
  });

  it('is pure: it never mutates the input rows', () => {
    const frozen = MOCK_ROWS.map((r) => ({ ...r, range: { ...r.range } }));
    aggregateCostBuckets(MOCK_ROWS);
    expect(MOCK_ROWS).toEqual(frozen);
  });
});
