/**
 * Which no-results hint fits what the user typed (#701).
 *
 * Presentation only: it picks a config-owned sentence, it never changes what
 * is searched (the API normalises and searches). Mirrors the API's query
 * classification in `apps/api/src/lib/address-query.ts` closely enough to
 * pick the right sentence; a mismatch only ever falls back to the generic
 * no-results copy.
 */
export type NoResultsHintKind = 'postal_code' | 'unit' | 'no_house_number' | 'generic';

/** A Canadian postal code and nothing else of substance ("T2T 0X5, Calgary, AB"). */
const POSTAL_ONLY =
  /^[ABCEGHJ-NPR-TV-Z]\d[ABCEGHJ-NPR-TV-Z]\s?\d[ABCEGHJ-NPR-TV-Z]\d(?:[\s,]*CALGARY)?(?:[\s,]*(?:AB|ALBERTA))?[\s,.]*$/;
/** "#201 …", "Unit 201 …", "Suite 5 …", "201-1234 …", or the same at the end. */
const UNIT =
  /^(?:#\s*\w+|(?:UNIT|SUITE|STE|APT|APARTMENT)\s+#?\s*\w+|\d+[A-Z]?\s*-\s*\d)|(?:\s#\s*\w+|\s(?:UNIT|SUITE|STE|APT|APARTMENT)\s+#?\s*\w+)$/;
const STARTS_WITH_NUMBER = /^\d/;

/** Classifies a trimmed query that returned no suggestions. */
export function noResultsHintKind(query: string): NoResultsHintKind {
  const text = query.trim().toUpperCase();
  if (text === '') return 'generic';
  if (POSTAL_ONLY.test(text)) return 'postal_code';
  if (UNIT.test(text)) return 'unit';
  if (!STARTS_WITH_NUMBER.test(text)) return 'no_house_number';
  return 'generic';
}
