/**
 * Human-readable property address for email copy (#703).
 *
 * `address_key` is the City dataset address as stored — uppercase
 * ("1412 PROSPECT AV SW"). Emails show it title-cased with the quadrant
 * kept uppercase ("1412 Prospect Av SW"), the same display rule the web
 * app applies. Slug-shaped keys (hyphenated, no spaces — test fixtures,
 * API callers) are split on hyphens first. Pure — no I/O.
 */
const QUADRANT = /^(NW|NE|SW|SE|N|S|E|W)$/i;

export function formatDisplayAddress(addressKey: string): string {
  const trimmed = addressKey.trim();
  if (trimmed.length === 0) return '';
  const spaced = /\s/.test(trimmed) ? trimmed : trimmed.replace(/-+/g, ' ');
  const words = spaced.split(/\s+/);
  return words
    .map((word, index) =>
      index === words.length - 1 && QUADRANT.test(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(' ');
}
