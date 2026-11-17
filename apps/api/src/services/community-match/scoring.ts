/**
 * Community match scoring (#778) — pure, deterministic, zero I/O.
 *
 * Input: the precomputed per-community metrics (amenity nearest distances,
 * tree-cover level, typically designated grade bands, listed lot areas) and
 * the visitor's priorities. Output: every community scored 0–100 and ranked.
 *
 * Rules:
 * - Each priority scores 0..1 and is either met or missed.
 * - match = round(100 × Σ weight·score / Σ weight); a must-have weighs
 *   `mustWeight`, a nice-to-have `niceWeight` (config; must > nice).
 * - A community that misses any must-have ranks below every community that
 *   passes them all, whatever its score; its misses say why.
 * - Ties break on the unrounded score, then name, then City code — so the
 *   same priorities over the same data always give the same ranking.
 *
 * No clock, no randomness, no dollar figures (the service adds the cost
 * engine's typical new-build range).
 */
import type {
  CommunityMatchImportance,
  CommunityMatchNote,
  DesignationGradeBand,
} from '@feasly/contracts';
import { DESIGNATED_SCHOOLS_PRIORITY, TREE_COVER_PRIORITY } from '@feasly/contracts';

export type TreeCoverLevel = 'low' | 'moderate' | 'high';

/** One community's precomputed inputs (from our tables only). */
export interface CommunityMatchInput {
  readonly communityCode: string;
  readonly slug: string;
  readonly name: string;
  /** Category key → nearest straight-line distance (m) within the search radius; null when none. */
  readonly amenityNearestM: Readonly<Record<string, number | null>>;
  readonly treeCover: { readonly level: TreeCoverLevel; readonly treesPerHa: number } | null;
  /** Grade bands with at least one typically designated school (any board). */
  readonly designatedBands: readonly DesignationGradeBand[];
  /** Area (sq ft) of each listed lot; null when the City has none. */
  readonly lotSqft: readonly (number | null)[];
  readonly lotsRefreshedAt: string | null;
}

export type PriorityKind = 'amenity' | 'tree-cover' | 'designated-schools';

/** A priority the visitor can pick (amenity categories come from config). */
export interface PriorityDefinition {
  readonly key: string;
  readonly label: string;
  readonly kind: PriorityKind;
}

export interface MatchPriority {
  readonly key: string;
  readonly importance: CommunityMatchImportance;
}

export interface MatchFilters {
  readonly minFrontageFt?: number;
  readonly lotsListedNow?: boolean;
}

export interface ScoringConfig {
  readonly mustWeight: number;
  readonly niceWeight: number;
  /** Amenity met when the nearest is within this distance. */
  readonly nearRadiusM: number;
  /** Amenity score reaches 0 here (the stored search radius). */
  readonly searchRadiusM: number;
  readonly treeCoverScores: Readonly<Record<TreeCoverLevel, number>>;
  readonly typicalLotDepthFt: number;
  readonly maxReasons: number;
}

export interface ScoredCommunity {
  readonly input: CommunityMatchInput;
  readonly rank: number;
  /** 0–100. */
  readonly match: number;
  /** Unrounded 0..1 (tie-break). */
  readonly score: number;
  readonly passesMustHaves: boolean;
  readonly reasons: readonly CommunityMatchNote[];
  readonly misses: readonly CommunityMatchNote[];
  readonly lots: { readonly listed: number; readonly matching: number };
}

/** Thrown for a priority key with no definition (the route answers 400). */
export class UnknownPriorityError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Unknown priority: ${keys.join(', ')}`);
    this.name = 'UnknownPriorityError';
  }
}

/** The fixed (non-amenity) priorities, in display order. */
export const FIXED_PRIORITIES: readonly PriorityDefinition[] = [
  { key: TREE_COVER_PRIORITY, label: 'Public tree cover', kind: 'tree-cover' },
  { key: DESIGNATED_SCHOOLS_PRIORITY, label: 'Typically designated schools', kind: 'designated-schools' },
];

/** Amenity categories (config order) + the fixed priorities. */
export function priorityDefinitions(
  amenityCategories: readonly { readonly key: string; readonly label: string }[],
): readonly PriorityDefinition[] {
  return [
    ...amenityCategories.map((c): PriorityDefinition => ({ key: c.key, label: c.label, kind: 'amenity' })),
    ...FIXED_PRIORITIES,
  ];
}

/** Grade groups a family needs covered: elementary, junior high, high school. */
const GRADE_GROUPS: readonly { readonly label: string; readonly bands: readonly DesignationGradeBand[] }[] = [
  { label: 'K–6', bands: ['K-6', 'K-9'] },
  { label: '7–9', bands: ['7-9', 'K-9'] },
  { label: '10–12', bands: ['10-12'] },
];

interface PriorityOutcome {
  readonly key: string;
  readonly importance: CommunityMatchImportance;
  readonly index: number;
  readonly weight: number;
  readonly score: number;
  readonly met: boolean;
  readonly text: string;
}

/** "450 m" / "1.8 km" — rounded to 50 m / 0.1 km. */
export function formatMeters(meters: number): string {
  if (meters < 1_000) return `${Math.max(50, Math.round(meters / 50) * 50)} m`;
  const km = Math.round(meters / 100) / 10;
  return `${Number.isInteger(km) ? km.toFixed(0) : km.toFixed(1)} km`;
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function evaluate(
  def: PriorityDefinition,
  input: CommunityMatchInput,
  cfg: ScoringConfig,
): { score: number; met: boolean; text: string } {
  switch (def.kind) {
    case 'amenity': {
      const nearest = input.amenityNearestM[def.key] ?? null;
      if (nearest === null) {
        return { score: 0, met: false, text: `${def.label}: none within ${formatMeters(cfg.searchRadiusM)}` };
      }
      const met = nearest <= cfg.nearRadiusM;
      const span = cfg.searchRadiusM - cfg.nearRadiusM;
      const score = met ? 1 : span > 0 ? clamp01((cfg.searchRadiusM - nearest) / span) : 0;
      return { score, met, text: `${def.label}: nearest about ${formatMeters(nearest)} away (straight-line)` };
    }
    case 'tree-cover': {
      if (!input.treeCover) return { score: 0, met: false, text: 'Public tree cover: no data on file' };
      const { level, treesPerHa } = input.treeCover;
      const score = clamp01(cfg.treeCoverScores[level]);
      return {
        score,
        met: level !== 'low',
        text: `Public tree cover: ${level} (${Math.round(treesPerHa)} City trees per hectare)`,
      };
    }
    case 'designated-schools': {
      const covered = GRADE_GROUPS.filter((g) => g.bands.some((b) => input.designatedBands.includes(b)));
      const missing = GRADE_GROUPS.filter((g) => !covered.includes(g));
      const score = covered.length / GRADE_GROUPS.length;
      if (missing.length === 0) {
        return {
          score,
          met: true,
          text: `Typically designated schools for ${listWords(covered.map((g) => g.label))} (confirm with the board)`,
        };
      }
      const none = `none on file for ${listWords(missing.map((g) => g.label))}`;
      return {
        score,
        met: false,
        text:
          covered.length === 0
            ? `No typically designated school on file for ${listWords(missing.map((g) => g.label))} (confirm with the board)`
            : `Typically designated schools for ${listWords(covered.map((g) => g.label))}; ${none} (confirm with the board)`,
      };
    }
  }
}

/** Estimated frontage (ft) = lot area / typical depth. */
export function estimatedFrontageFt(lotSqft: number, typicalLotDepthFt: number): number {
  return lotSqft / typicalLotDepthFt;
}

export function countLots(
  input: CommunityMatchInput,
  filters: MatchFilters,
  typicalLotDepthFt: number,
): { listed: number; matching: number } {
  const listed = input.lotSqft.length;
  const min = filters.minFrontageFt;
  if (min === undefined) return { listed, matching: listed };
  const matching = input.lotSqft.filter(
    (sqft) => sqft !== null && estimatedFrontageFt(sqft, typicalLotDepthFt) >= min,
  ).length;
  return { listed, matching };
}

function note(o: PriorityOutcome): CommunityMatchNote {
  return { priority: o.key, importance: o.importance, text: o.text };
}

function scoreOne(
  input: CommunityMatchInput,
  defs: readonly { def: PriorityDefinition; priority: MatchPriority; index: number }[],
  lots: { listed: number; matching: number },
  cfg: ScoringConfig,
): Omit<ScoredCommunity, 'rank'> {
  const outcomes: PriorityOutcome[] = defs.map(({ def, priority, index }) => ({
    key: def.key,
    importance: priority.importance,
    index,
    weight: priority.importance === 'must' ? cfg.mustWeight : cfg.niceWeight,
    ...evaluate(def, input, cfg),
  }));
  const totalWeight = outcomes.reduce((sum, o) => sum + o.weight, 0);
  const score = totalWeight > 0 ? outcomes.reduce((sum, o) => sum + o.weight * o.score, 0) / totalWeight : 0;
  const passesMustHaves = outcomes.every((o) => o.importance !== 'must' || o.met);

  const strongest = (a: PriorityOutcome, b: PriorityOutcome): number =>
    b.weight - a.weight || b.score - a.score || a.index - b.index;

  let reasons: CommunityMatchNote[] = outcomes
    .filter((o) => o.met)
    .sort(strongest)
    .slice(0, cfg.maxReasons)
    .map(note);
  if (reasons.length === 0) {
    // Nothing met: the best partial nice-to-have, else a plain fact.
    const partial = outcomes.filter((o) => o.importance === 'nice' && o.score > 0).sort(strongest)[0];
    if (partial) reasons = [note(partial)];
    else if (lots.matching > 0) {
      reasons = [
        {
          priority: 'lots',
          importance: null,
          text: `${lots.matching} ${lots.matching === 1 ? 'lot' : 'lots'} listed now`,
        },
      ];
    } else {
      reasons = [{ priority: 'established', importance: null, text: 'Established infill community' }];
    }
  }

  const misses = outcomes
    .filter((o) => !o.met)
    .sort((a, b) => (a.importance === b.importance ? a.index - b.index : a.importance === 'must' ? -1 : 1))
    .map(note);

  return {
    input,
    match: Math.round(score * 100),
    score,
    passesMustHaves,
    reasons,
    misses,
    lots,
  };
}

/**
 * Score and rank every community. Throws UnknownPriorityError for a key
 * with no definition. Filters drop communities before ranking.
 */
export function rankCommunities(
  communities: readonly CommunityMatchInput[],
  priorities: readonly MatchPriority[],
  filters: MatchFilters,
  definitions: readonly PriorityDefinition[],
  cfg: ScoringConfig,
): ScoredCommunity[] {
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  const unknown = priorities.filter((p) => !byKey.has(p.key)).map((p) => p.key);
  if (unknown.length > 0) throw new UnknownPriorityError(unknown);
  const defs = priorities.map((priority, index) => ({ def: byKey.get(priority.key)!, priority, index }));

  const scored: Omit<ScoredCommunity, 'rank'>[] = [];
  for (const input of communities) {
    const lots = countLots(input, filters, cfg.typicalLotDepthFt);
    if (filters.lotsListedNow && lots.matching === 0) continue;
    scored.push(scoreOne(input, defs, lots, cfg));
  }
  scored.sort(
    (a, b) =>
      Number(b.passesMustHaves) - Number(a.passesMustHaves) ||
      b.match - a.match ||
      b.score - a.score ||
      a.input.name.localeCompare(b.input.name, 'en') ||
      (a.input.communityCode < b.input.communityCode ? -1 : a.input.communityCode > b.input.communityCode ? 1 : 0),
  );
  return scored.map((s, i) => ({ ...s, rank: i + 1 }));
}
