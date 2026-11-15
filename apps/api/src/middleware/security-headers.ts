/**
 * Security headers for Function responses (BE8-002).
 *
 * The Static Web App serves the frontend with its own header set
 * (staticwebapp.config.json); the Functions API is called directly, so
 * every adapter merges these headers into `context.res`. Values are fixed
 * security best practices, not tunables — they do not belong in config.
 *
 * - `X-Content-Type-Options: nosniff` — blocks MIME-sniffing attacks.
 * - `X-Frame-Options: DENY` — API responses are JSON, never framed.
 * - `Referrer-Policy: strict-origin-when-cross-origin` — least referrer
 *   leakage on any cross-origin navigation from API-driven flows.
 * - `Cache-Control: no-store` — default for every response (#795, ASVS
 *   8.2.1). Session, magic-token and API-key responses carry PII, so no
 *   browser or shared cache may keep them. Deliberately public, cacheable
 *   responses (`/openapi.json`, the zoning catalogue) override it by setting
 *   their own `Cache-Control` AFTER spreading these headers.
 *
 * HSTS is intentionally NOT set here: Azure terminates TLS at the edge
 * and already emits it; duplicating it risks conflicting values.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cache-Control': 'no-store',
};

/**
 * Fresh copy of the security headers for one response. Adapters spread
 * the result into their `context.res` headers alongside CORS headers.
 */
export function securityHeaders(): Record<string, string> {
  return { ...SECURITY_HEADERS };
}
