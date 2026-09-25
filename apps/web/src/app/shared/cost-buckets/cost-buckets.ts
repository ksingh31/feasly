/**
 * Cost-bucket aggregation for the estimate report.
 *
 * Pure helper (inputs → buckets): the engine emits fine-grained cost rows,
 * the report renders only three broad buckets. Buckets aggregate the
 * SERVER-PRODUCED low/base/high rows by summation — the client never invents
 * trade figures.
 *
 * D-01 (story consumer/04-estimate-report-redesign): engine-row → bucket
 * mapping, checked in here:
 * - "Structure & exterior" ← hard.framing, hard.foundation, hard.envelope,
 *   hard.sitePrep (mock keys: framing, foundation, envelope, site)
 * - "Interior & home systems" ← hard.finishes, hard.mep (mock keys:
 *   interior, mechanical)
 * - "Design, permits & contingency" ← soft.design, soft.permits, contingency
 *   (mock keys: soft, contingency)
 * The `land` row is excluded (it renders as its own fixed City-assessed
 * figure). Any unmapped future row falls into "Design, permits &
 * contingency" as the "everything else" catch-all.
 */
import type { CostRange, CostRow } from '@feasly/contracts';

/** Stable bucket keys (also used as CSS class suffixes on the report). */
export type CostBucketKey = 'structure' | 'interior' | 'design';

export interface CostBucket {
  readonly key: CostBucketKey;
  readonly label: string;
  readonly range: CostRange;
}

const BUCKETS: readonly { key: CostBucketKey; label: string }[] = [
  { key: 'structure', label: 'Structure & exterior' },
  { key: 'interior', label: 'Interior & home systems' },
  { key: 'design', label: 'Design, permits & contingency' },
];

/** Engine dot-notation keys plus the legacy mock-harness keys. */
const ROW_TO_BUCKET: Readonly<Record<string, CostBucketKey>> = {
  'hard.framing': 'structure',
  'hard.foundation': 'structure',
  'hard.envelope': 'structure',
  'hard.sitePrep': 'structure',
  'hard.finishes': 'interior',
  'hard.mep': 'interior',
  'soft.design': 'design',
  'soft.permits': 'design',
  contingency: 'design',
  // Legacy mock-harness keys (mock-data.ts mockRows).
  site: 'structure',
  foundation: 'structure',
  framing: 'structure',
  envelope: 'structure',
  interior: 'interior',
  mechanical: 'interior',
  soft: 'design',
};

/** The `land` row is excluded — it renders as the fixed City-assessed figure. */
const LAND_KEY = 'land';

/** "Everything else" catch-all for unmapped future rows. */
const CATCH_ALL: CostBucketKey = 'design';

const ZERO: CostRange = { low: 0, base: 0, high: 0 };

/**
 * Aggregates engine cost rows into exactly three buckets. Always returns all
 * three buckets in display order, even when no rows map to one (zero range).
 */
export function aggregateCostBuckets(rows: readonly CostRow[]): readonly CostBucket[] {
  const sums = new Map<CostBucketKey, { low: number; base: number; high: number }>();
  for (const row of rows) {
    if (row.key === LAND_KEY) {
      continue;
    }
    const bucket = ROW_TO_BUCKET[row.key] ?? CATCH_ALL;
    let acc = sums.get(bucket);
    if (!acc) {
      acc = { low: 0, base: 0, high: 0 };
      sums.set(bucket, acc);
    }
    acc.low += row.range.low;
    acc.base += row.range.base;
    acc.high += row.range.high;
  }
  return BUCKETS.map(({ key, label }) => {
    const s = sums.get(key);
    return { key, label, range: s ? { low: s.low, base: s.base, high: s.high } : { ...ZERO } };
  });
}
