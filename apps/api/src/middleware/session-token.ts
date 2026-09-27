/**
 * Session-token extraction (ADM-10 bearer fix).
 *
 * Admin/builder sessions are opaque tokens stored server-side
 * (`admin_sessions` / `builder_sessions`). The SPA is cross-origin to the
 * Function App, and modern browsers (iOS Safari ITP, Chrome, Firefox,
 * desktop Safari) block the third-party `Set-Cookie` on the cross-origin
 * verify XHR — so the session never stuck and every sign-in bounced back
 * to the email-entry page. The verify endpoint therefore also returns the
 * session token in the JSON body; the client stores it and sends it back
 * as `Authorization: Bearer <token>` on every admin/builder request.
 *
 * Extraction order: an explicit `Authorization: Bearer` header wins over
 * the ambient cookie. The cookie path is kept for a same-origin future
 * (and emits harmlessly cross-origin today).
 */
export type HeaderRecord = Record<string, string | string[] | undefined>;

/**
 * Extract the token from an `Authorization: Bearer <token>` header.
 * Returns null when absent or malformed (the guard treats it as
 * unauthenticated). Header names arrive lowercased from the adapters.
 */
export function parseBearerToken(headers: HeaderRecord): string | null {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const match = /^Bearer (.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * Extract a named cookie's value from the `Cookie` header. Returns null
 * when absent or empty.
 */
export function parseCookieValue(headers: HeaderRecord, cookieName: string): string | null {
  const raw = headers['cookie'];
  const cookieHeader = Array.isArray(raw) ? raw[0] : raw;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === cookieName) {
      const value = part.slice(idx + 1).trim();
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

/**
 * Resolve the session token for a named session cookie: Bearer <redacted>
 * first, then the httpOnly session cookie. Null when neither is present.
 */
export function extractSessionToken(headers: HeaderRecord, cookieName: string): string | null {
  return parseBearerToken(headers) ?? parseCookieValue(headers, cookieName);
}
