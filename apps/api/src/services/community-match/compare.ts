/**
 * Community compare (#780) — pure, deterministic, zero I/O.
 *
 * Turns 2–3 communities' precomputed match inputs into comparison rows
 * (schools, amenities, tree cover, building here), each cell in plain words
 * with the row's best value marked. "Best" is decided here, not in the UI:
 *
 * - schools: a typically designated school on file beats none;
 * - amenities: the nearest (straight-line) wins;
 * - tree cover: the most City trees per hectare wins;
 * - lots listed / average lot size: the most wins;
 * - typical new-build range: no better/worse direction, never marked.
 *
 * Ties are all marked; a row whose values are all equal (or all missing)
 * marks nothing, so a highlight always means "better than another column".
 */
import type {
  CommunityCompareCell,
  CommunityCompareRow,
  CommunityMatchBuildRange,
} from '@feasly/contracts';
import { DESIGNATED_SCHOOLS_PRIORITY, TREE_COVER_PRIORITY } from '@feasly/contracts';
import { formatMeters, GRADE_GROUPS, type CommunityMatchInput } from './scoring';

export interface CompareCommunityInput extends CommunityMatchInput {
  readonly avgLotSqft: number | null;
  readonly typicalNewBuild: CommunityMatchBuildRange | null;
}

export interface CompareConfig {
  /** Amenity categories in config order. */
  readonly amenityCategories: readonly { readonly key: string; readonly label: string }[];
  /** Search radius behind `amenityNearestM` (null = none within it). */
  readonly searchRadiusM: number;
}

/** Thrown when a requested slug is not an established community we cover (the route answers 404). */
export class UnknownCommunityError extends Error {
  constructor(readonly slugs: readonly string[]) {
    super(`Unknown community: ${slugs.join(', ')}`);
    this.name = 'UnknownCommunityError';
  }
}

export type CompareDirection = 'higher' | 'lower' | 'none';

export interface RawCompareCell {
  readonly text: string;
  /** Comparable value; null = missing (never best). */
  readonly value: number | null;
  readonly range?: CommunityMatchBuildRange;
}

/** Row label per grade group (GRADE_GROUPS label → plain words). */
const SCHOOL_ROW_LABELS: Readonly<Record<string, string>> = {
  'K–6': 'Elementary (K–6)',
  '7–9': 'Junior high (7–9)',
  '10–12': 'High school (10–12)',
};

/** Marks the best value(s); nothing when every value is equal, all are missing, or there is no direction. */
export function markBest(cells: readonly RawCompareCell[], direction: CompareDirection): CommunityCompareCell[] {
  const values = cells.map((c) => c.value).filter((v): v is number => v !== null);
  let best: number | null = null;
  if (direction !== 'none' && values.length > 0) {
    const top = direction === 'higher' ? Math.max(...values) : Math.min(...values);
    const allEqual = values.length === cells.length && values.every((v) => v === top);
    if (!allEqual) best = top;
  }
  return cells.map((c) => ({
    text: c.text,
    best: best !== null && c.value === best,
    ...(c.range ? { range: c.range } : {}),
  }));
}

function cad(value: number): string {
  return `$${Math.round(value).toLocaleString('en-CA')}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-CA')} ${count === 1 ? one : many}`;
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Comparison rows for the given communities (cells in input order). */
export function buildCompareRows(
  communities: readonly CompareCommunityInput[],
  cfg: CompareConfig,
): CommunityCompareRow[] {
  const rows: CommunityCompareRow[] = [];
  const row = (
    key: string,
    kind: CommunityCompareRow['kind'],
    priority: string | null,
    label: string,
    direction: CompareDirection,
    cell: (c: CompareCommunityInput) => RawCompareCell,
  ): void => {
    rows.push({ key, kind, priority, label, cells: markBest(communities.map(cell), direction) });
  };

  // Schools: one row per grade group a family needs covered.
  for (const group of GRADE_GROUPS) {
    const key = `schools-${group.bands[0]!.toLowerCase()}`;
    const label = SCHOOL_ROW_LABELS[group.label] ?? group.label;
    row(key, 'schools', DESIGNATED_SCHOOLS_PRIORITY, label, 'higher', (c) =>
      group.bands.some((b) => c.designatedBands.includes(b))
        ? { text: 'Typically designated school on file', value: 1 }
        : { text: 'None on file', value: 0 },
    );
  }

  // Amenities: the nearest one, straight-line from the community centre.
  for (const category of cfg.amenityCategories) {
    row(`amenity-${category.key}`, 'amenity', category.key, category.label, 'lower', (c) => {
      const nearest = c.amenityNearestM[category.key] ?? null;
      return nearest === null
        ? { text: `None within ${formatMeters(cfg.searchRadiusM)}`, value: null }
        : { text: `Nearest about ${formatMeters(nearest)}`, value: nearest };
    });
  }

  row('tree-cover', 'tree-cover', TREE_COVER_PRIORITY, 'Public tree cover', 'higher', (c) => {
    if (!c.treeCover) return { text: 'No data on file', value: null };
    const perHa = Math.round(c.treeCover.treesPerHa);
    return { text: `${capitalise(c.treeCover.level)} (${perHa} City trees per hectare)`, value: perHa };
  });

  // Building here.
  row('lots-listed', 'building', null, 'Lots listed now', 'higher', (c) => ({
    text: c.lotSqft.length === 0 ? 'None listed right now' : plural(c.lotSqft.length, 'lot', 'lots'),
    value: c.lotSqft.length,
  }));
  row('avg-lot-size', 'building', null, 'Average lot size', 'higher', (c) => {
    if (c.avgLotSqft === null || !Number.isFinite(c.avgLotSqft) || c.avgLotSqft <= 0) {
      return { text: 'No lot-size data yet', value: null };
    }
    const sqft = Math.round(c.avgLotSqft);
    return { text: `${sqft.toLocaleString('en-CA')} sq ft`, value: sqft };
  });
  row('typical-new-build', 'building', null, 'Typical new build', 'none', (c) =>
    c.typicalNewBuild
      ? {
          text: `${cad(c.typicalNewBuild.low)}–${cad(c.typicalNewBuild.high)}`,
          value: null,
          range: c.typicalNewBuild,
        }
      : { text: 'No lot-size data yet', value: null },
  );

  return rows;
}
