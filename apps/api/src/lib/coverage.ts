/**
 * Calgary coverage detection (story reno/05).
 *
 * Pure helper: given a free-text address query, decides whether it carries a
 * Calgary signal, an explicit out-of-coverage signal, or neither. The
 * heuristic is deliberately conservative — ambiguous input returns
 * 'ambiguous' so callers fall back to ADDRESS_NOT_FOUND rather than
 * wrongly telling a Calgarian they're out of coverage.
 *
 * Signals:
 * - Calgary: Canadian postal code with a T2/T3 prefix (Calgary FSAs), or an
 *   explicit "calgary" token.
 * - Out-of-coverage: a valid Canadian postal code NOT starting with T2/T3
 *   (e.g. V6B, M5V, T5J), or an explicit non-Calgary city token.
 * - Ambiguous: everything else (street addresses without city/postal).
 *
 * No I/O, no clock, no env — inject nothing. Tested in test/coverage.test.ts.
 */

/** Verdict of the coverage heuristic. */
export type CoverageSignal = 'calgary' | 'out-of-coverage' | 'ambiguous';

/**
 * Canadian postal code shape: A1A 1A1 (space optional). The first letter is
 * never D, F, I, O, Q, or U.
 */
const POSTAL_CODE =
  /\b([ABCEGHJ-NPR-TV-Z])(\d)([ABCEGHJ-NPR-TV-Z])\s?(\d)([ABCEGHJ-NPR-TV-Z])(\d)\b/i;

/** Calgary forward-sortation areas: T2* and T3*. */
const CALGARY_FSA = /^T[23]/i;

/**
 * Explicit non-Calgary city tokens. These are the municipalities whose
 * residents might plausibly try Feasly; matching is on word boundaries so
 * "Edmonton" doesn't fire on "Edmontonian Estates" street names... it would,
 * actually — which is why the heuristic stays conservative and callers only
 * treat an out-of-coverage verdict as authoritative after a Socrata miss.
 */
const NON_CALGARY_CITIES = [
  'edmonton',
  'toronto',
  'vancouver',
  'ottawa',
  'montreal',
  'winnipeg',
  'halifax',
  'victoria',
  'regina',
  'saskatoon',
  'kelowna',
  'red deer',
  'lethbridge',
  'st. albert',
  'mississauga',
  'brampton',
  'surrey',
  'burnaby',
  'richmond',
  'coquitlam',
] as const;

function containsCityToken(lowered: string, cities: readonly string[]): boolean {
  return cities.some((city) => {
    // Word-boundary match so "victoria" doesn't fire inside "victorian".
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(lowered);
  });
}

/**
 * Classifies a free-text address query by coverage signal.
 *
 * Precedence: an explicit Calgary signal wins over a conflicting
 * out-of-coverage token (e.g. "Calgary, formerly Edmonton" is nonsense
 * input — treat as Calgarian and let the Socrata miss decide).
 */
export function detectCoverageSignal(input: string): CoverageSignal {
  const text = input.trim();
  if (!text) return 'ambiguous';
  const lowered = text.toLowerCase();

  const postal = lowered.match(POSTAL_CODE);
  if (postal) {
    return CALGARY_FSA.test(postal[1] + postal[2]) ? 'calgary' : 'out-of-coverage';
  }

  if (/\bcalgary\b/i.test(lowered)) return 'calgary';
  if (containsCityToken(lowered, NON_CALGARY_CITIES)) return 'out-of-coverage';
  return 'ambiguous';
}
