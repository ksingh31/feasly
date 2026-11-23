import { describe, expect, it } from 'vitest';
import {
  cyclePriority,
  decodeCompareSlugs,
  decodeSelection,
  encodeCompareSlugs,
  EMPTY_SELECTION,
  encodeSelection,
  nextImportance,
  toggleFilter,
  toMatchRequest,
  type MatchSelection,
} from './match-selection';

const KNOWN = new Set(['parks', 'designated-schools', 'tree-cover']);

describe('match-selection (#779)', () => {
  it('cycles off → nice → must → off', () => {
    expect(nextImportance(null)).toBe('nice');
    expect(nextImportance('nice')).toBe('must');
    expect(nextImportance('must')).toBeNull();

    let s = cyclePriority(EMPTY_SELECTION, 'parks');
    expect(s.priorities).toEqual([{ key: 'parks', importance: 'nice' }]);
    s = cyclePriority(s, 'parks');
    expect(s.priorities).toEqual([{ key: 'parks', importance: 'must' }]);
    s = cyclePriority(s, 'parks');
    expect(s.priorities).toEqual([]);
  });

  it('keeps the order priorities were chosen in', () => {
    let s = cyclePriority(EMPTY_SELECTION, 'tree-cover');
    s = cyclePriority(s, 'parks');
    s = cyclePriority(s, 'tree-cover');
    expect(s.priorities.map((p) => p.key)).toEqual(['tree-cover', 'parks']);
  });

  it('toggles build filters on/off in a stable order', () => {
    let s = toggleFilter(EMPTY_SELECTION, 'wide-lot');
    s = toggleFilter(s, 'lots-listed-now');
    expect(s.filters).toEqual(['lots-listed-now', 'wide-lot']);
    s = toggleFilter(s, 'wide-lot');
    expect(s.filters).toEqual(['lots-listed-now']);
  });

  it('round-trips through the hash', () => {
    const s: MatchSelection = {
      priorities: [
        { key: 'parks', importance: 'nice' },
        { key: 'designated-schools', importance: 'must' },
      ],
      filters: ['lots-listed-now'],
    };
    const hash = encodeSelection(s);
    expect(hash).toBe('p=parks:n,designated-schools:m&f=lots-listed-now');
    expect(decodeSelection(`#${hash}`, KNOWN)).toEqual(s);
  });

  it('drops unknown, malformed and duplicate entries from a link', () => {
    expect(decodeSelection('p=parks:m,pools:n,parks:n,Bad_Key:n,tree-cover:x&f=wide-lot,nope', KNOWN)).toEqual({
      priorities: [{ key: 'parks', importance: 'must' }],
      filters: ['wide-lot'],
    });
  });

  it('ignores a malformed escape (truncated share link) instead of throwing', () => {
    expect(() => decodeSelection('#p=parks%', KNOWN)).not.toThrow();
    expect(decodeSelection('#p=parks%', KNOWN)).toBeNull();
    expect(decodeSelection('#p=%E0', KNOWN)).toBeNull();
    expect(decodeSelection('#p=parks%&f=wide-lot', KNOWN)).toEqual({ priorities: [], filters: ['wide-lot'] });
  });

  it('returns null when the hash carries no selection', () => {
    expect(decodeSelection(null, KNOWN)).toBeNull();
    expect(decodeSelection('', KNOWN)).toBeNull();
    expect(decodeSelection('#main-content', KNOWN)).toBeNull();
  });

  it('builds the API request, or null without priorities', () => {
    const options = { wideLotFrontageFt: 50, limit: 30 };
    expect(toMatchRequest(EMPTY_SELECTION, options)).toBeNull();
    expect(
      toMatchRequest(
        { priorities: [{ key: 'parks', importance: 'must' }], filters: ['lots-listed-now', 'wide-lot'] },
        options,
      ),
    ).toEqual({
      priorities: [{ key: 'parks', importance: 'must' }],
      filters: { lotsListedNow: true, minFrontageFt: 50 },
      limit: 30,
    });
    expect(toMatchRequest({ priorities: [{ key: 'parks', importance: 'nice' }], filters: [] }, options)).toEqual({
      priorities: [{ key: 'parks', importance: 'nice' }],
      limit: 30,
    });
  });

  it('compare link (#780): slugs in the hash, valid + unique, capped', () => {
    expect(encodeCompareSlugs(['altadore', 'killarney-glengarry'])).toBe('altadore,killarney-glengarry');
    expect(decodeCompareSlugs('#altadore,killarney-glengarry', 3)).toEqual(['altadore', 'killarney-glengarry']);
    expect(decodeCompareSlugs('altadore,,Altadore, bowness ,bad slug,x_y', 3)).toEqual(['altadore', 'bowness']);
    expect(decodeCompareSlugs('a,b,c,d', 3)).toEqual(['a', 'b', 'c']);
    expect(decodeCompareSlugs('altadore%2Cbowness', 3)).toEqual(['altadore', 'bowness']);
    expect(decodeCompareSlugs('altadore,bow%', 3)).toEqual(['altadore']);
    expect(decodeCompareSlugs(null, 3)).toEqual([]);
    expect(decodeCompareSlugs('', 3)).toEqual([]);
  });
});
