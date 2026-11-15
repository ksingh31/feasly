/**
 * Estimator deep-link parameters (#692): `/?address=<text>&src=<source>`.
 *
 * Both values come straight from a URL anyone can craft, so they are
 * untrusted text. These helpers only decide whether to accept a value; the
 * accepted address goes through the same autocomplete lookup as typed input
 * (it is sent as the `q` value of a normal search, never put into a query
 * string or the DOM in any other way).
 */

/** Bounds for a deep-link address (config-owned: `deepLink`). */
export interface DeepLinkAddressBounds {
  readonly minLength: number;
  readonly maxLength: number;
}

/**
 * Characters a street address may contain: letters (any script, so accented
 * street names pass), digits, spaces and the punctuation used in Calgary
 * addresses ("#225-823 5 Av N.W.", "O'Brien Pl"). Anything else (angle
 * brackets, braces, control characters, quotes, `%`) marks the parameter
 * as malformed.
 */
const ADDRESS_CHARS = /^[\p{L}\p{N} .,'#/&-]+$/u;

/**
 * Accepts a deep-link address, or returns null when it should be ignored
 * (missing, too short, too long, or containing characters no address has).
 * The length is checked on the raw value before trimming so a long padded
 * string cannot pass. Runs of whitespace collapse to one space.
 */
export function parseDeepLinkAddress(
  raw: string | null | undefined,
  bounds: DeepLinkAddressBounds,
): string | null {
  if (typeof raw !== 'string' || raw.length > bounds.maxLength) return null;
  const text = raw.trim().replace(/\s+/g, ' ');
  if (text.length < bounds.minLength) return null;
  if (!ADDRESS_CHARS.test(text)) return null;
  return text;
}

/**
 * Accepts a deep-link `src` only when it exactly matches an allowlisted
 * value (case-insensitive). Unknown values are dropped (null).
 */
export function parseDeepLinkSource(
  raw: string | null | undefined,
  allowlist: readonly string[],
): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  return allowlist.find((allowed) => allowed.toLowerCase() === value) ?? null;
}
