import type {
  CommunityMatchFilters,
  CommunityMatchImportance,
  CommunityMatchPriority,
  CommunityMatchRequest,
} from '@feasly/contracts';

/**
 * Find a community (#779): the visitor's priorities and build filters, and
 * how they travel in the page link (URL hash) so a shared link reopens the
 * same ranking. Pure functions, no Angular: the hash format is pinned by
 * match-selection.spec.ts.
 */

/** Build-filter chips ("Your build" group). On/off, not nice/must. */
export type MatchFilterKey = 'lots-listed-now' | 'wide-lot';

export const MATCH_FILTER_KEYS: readonly MatchFilterKey[] = ['lots-listed-now', 'wide-lot'];

export interface MatchSelection {
  /** Chosen priorities, in the order they were chosen. Keys unique. */
  readonly priorities: readonly CommunityMatchPriority[];
  /** Build filters switched on. */
  readonly filters: readonly MatchFilterKey[];
}

export const EMPTY_SELECTION: MatchSelection = { priorities: [], filters: [] };

/** Tap order for a priority chip: off → nice → must → off. */
export function nextImportance(
  current: CommunityMatchImportance | null,
): CommunityMatchImportance | null {
  if (current === null) return 'nice';
  if (current === 'nice') return 'must';
  return null;
}

/** The selection with `key` advanced one tap (off → nice → must → off). */
export function cyclePriority(selection: MatchSelection, key: string): MatchSelection {
  const current = selection.priorities.find((p) => p.key === key)?.importance ?? null;
  const next = nextImportance(current);
  const priorities =
    next === null
      ? selection.priorities.filter((p) => p.key !== key)
      : current === null
        ? [...selection.priorities, { key, importance: next }]
        : selection.priorities.map((p) => (p.key === key ? { key, importance: next } : p));
  return { ...selection, priorities };
}

/** The selection with build filter `key` switched on/off. */
export function toggleFilter(selection: MatchSelection, key: MatchFilterKey): MatchSelection {
  const filters = selection.filters.includes(key)
    ? selection.filters.filter((f) => f !== key)
    : MATCH_FILTER_KEYS.filter((f) => f === key || selection.filters.includes(f));
  return { ...selection, filters };
}

const IMPORTANCE_CODE: Record<CommunityMatchImportance, string> = { nice: 'n', must: 'm' };
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Encodes a selection as a URL hash body (no leading '#'):
 * `p=parks:n,designated-schools:m&f=lots-listed-now`. Empty → ''.
 */
export function encodeSelection(selection: MatchSelection): string {
  const parts: string[] = [];
  if (selection.priorities.length > 0) {
    parts.push(`p=${selection.priorities.map((p) => `${p.key}:${IMPORTANCE_CODE[p.importance]}`).join(',')}`);
  }
  if (selection.filters.length > 0) {
    parts.push(`f=${selection.filters.join(',')}`);
  }
  return parts.join('&');
}

/**
 * Decodes a URL hash body (with or without '#'). Keys outside
 * `knownPriorities` and unknown filters are dropped, duplicates keep the
 * first. Returns null when the hash carries no selection at all, so the
 * caller can fall back to the saved one.
 */
export function decodeSelection(
  hash: string | null | undefined,
  knownPriorities: ReadonlySet<string>,
): MatchSelection | null {
  const body = (hash ?? '').replace(/^#/, '');
  if (!body) return null;
  const params = new Map<string, string>();
  for (const pair of body.split('&')) {
    const [name, value = ''] = pair.split('=');
    if (!name) continue;
    try {
      params.set(name, decodeURIComponent(value));
    } catch {
      // Malformed escape (e.g. a truncated share link): ignore this pair.
    }
  }
  if (!params.has('p') && !params.has('f')) return null;
  const priorities: CommunityMatchPriority[] = [];
  for (const item of (params.get('p') ?? '').split(',')) {
    const [key, code] = item.split(':');
    if (!key || !KEY_PATTERN.test(key) || !knownPriorities.has(key)) continue;
    if (priorities.some((p) => p.key === key)) continue;
    const importance: CommunityMatchImportance | null = code === 'm' ? 'must' : code === 'n' ? 'nice' : null;
    if (importance) priorities.push({ key, importance });
  }
  const wanted = new Set((params.get('f') ?? '').split(','));
  const filters = MATCH_FILTER_KEYS.filter((f) => wanted.has(f));
  return { priorities, filters };
}

/** Request for the selection; null when no priority is chosen (the API needs ≥ 1). */
export function toMatchRequest(
  selection: MatchSelection,
  options: { readonly wideLotFrontageFt: number; readonly limit: number },
): CommunityMatchRequest | null {
  if (selection.priorities.length === 0) return null;
  const filters: { -readonly [K in keyof CommunityMatchFilters]: CommunityMatchFilters[K] } = {};
  if (selection.filters.includes('lots-listed-now')) filters.lotsListedNow = true;
  if (selection.filters.includes('wide-lot')) filters.minFrontageFt = options.wideLotFrontageFt;
  return {
    priorities: selection.priorities.map((p) => ({ key: p.key, importance: p.importance })),
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    limit: options.limit,
  };
}

/** Stable identity for de-duplicating requests (same selection → same key). */
export function selectionKey(selection: MatchSelection): string {
  return encodeSelection(selection);
}
