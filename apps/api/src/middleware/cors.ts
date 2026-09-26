/**
 * CORS origin allowlist enforcement (HRD-01).
 *
 * The Functions trigger adapters are thin by design, so they call
 * `resolveCorsHeaders()` and merge the result into `context.res` headers.
 * Origins are compared exactly (case-insensitive); there is deliberately
 * no wildcard and no subdomain matching — the allowlist is owned by
 * config.ts (`CORS_ORIGINS`, plus localhost defaults in development only).
 *
 * - A request whose `Origin` is allowlisted gets
 *   `Access-Control-Allow-Origin: <origin>` (echoed, never `*`) plus
 *   `Vary: Origin` and `Access-Control-Allow-Credentials: true`.
 * - `Access-Control-Allow-Credentials: true` is REQUIRED: this is the
 *   single CORS source (no platform-level CORS on the Function App), and
 *   the web app calls the API cross-origin with `withCredentials`, so
 *   the session cookies (`SameSite=None; Secure`) only flow when the
 *   browser sees this header. Echo + credentials demands `Vary: Origin`
 *   so shared caches never serve one origin's response to another.
 * - Any other origin (or a missing `Origin` header) gets no CORS headers
 *   at all — fail-closed.
 * - `isPreflight()` identifies CORS preflight requests so adapters can
 *   answer them with 204 before the pipeline runs; `preflightHeaders()`
 *   supplies the static preflight response headers.
 *
 * Hard rule (enforced by test/boundaries.test.ts): this module never
 * embeds literal origins — the allowlist arrives as an argument.
 */
export const VARY_ORIGIN = 'Vary';
export const ALLOW_ORIGIN = 'Access-Control-Allow-Origin';
export const ALLOW_CREDENTIALS = 'Access-Control-Allow-Credentials';

const ALLOW_METHODS = 'GET, POST, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization, X-Correlation-Id';
const MAX_AGE_SECONDS = '86400';

export type HeaderInput = string | string[] | undefined;

/** First value of a possibly-repeated header (e.g. `Origin`). */
function firstHeaderValue(value: HeaderInput): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** True when the request is a CORS preflight (OPTIONS + Origin present). */
export function isPreflight(method: string | undefined, origin: HeaderInput): boolean {
  return method?.toUpperCase() === 'OPTIONS' && !!firstHeaderValue(origin)?.trim();
}

/**
 * Response headers for a CORS request. Empty object when the origin is
 * not allowlisted (or absent) — adapters merge this into `context.res`.
 */
export function resolveCorsHeaders(
  origin: HeaderInput,
  allowlist: readonly string[],
): Record<string, string> {
  const candidate = firstHeaderValue(origin)?.trim();
  if (!candidate) return {};
  const match = allowlist.some((allowed) => allowed.toLowerCase() === candidate.toLowerCase());
  if (!match) return {};
  // Credentials MUST be allowed: the API is cross-origin by design (ADM-10)
  // and session auth is cookie-based (withCredentials on the client).
  return {
    [ALLOW_ORIGIN]: candidate,
    [ALLOW_CREDENTIALS]: 'true',
    [VARY_ORIGIN]: 'Origin',
  };
}

/** Static headers for a 204 preflight response (call after allowlist check). */
export function preflightHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': MAX_AGE_SECONDS,
  };
}
