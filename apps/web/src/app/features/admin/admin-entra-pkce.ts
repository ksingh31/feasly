/**
 * PKCE helpers for the Microsoft Entra External ID sign-in (auth/02
 * pivot, AUTH-02).
 *
 * The SPA never handles Entra tokens: it redirects to the
 * Microsoft-hosted `…/oauth2/v2.0/authorize` endpoint with an S256 PKCE
 * challenge, and the backend redeems the returned authorization code with
 * the matching verifier. These are pure functions (no Angular deps) so
 * they are unit-testable in isolation.
 *
 * RFC 7636 §4.1: `code_verifier` is 43–128 chars from [A-Z a-z 0-9 - . _
 * ~]. We generate 64 random bytes and base64url-encode them (86 chars).
 */

/** base64url-encode a byte buffer (RFC 4648 §5, no padding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Random 64-byte `code_verifier`, base64url-encoded (86 chars —
 * inside the RFC 7636 43–128 window). Kept in sessionStorage (not
 * localStorage) between the authorize redirect and the callback, so a
 * leaked disk copy can't replay the flow.
 */
export function createCodeVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * `code_challenge = BASE64URL-ENCODE(SHA256(ascii(code_verifier)))`
 * (RFC 7636 §4.2, S256 method). Async — `crypto.subtle` only.
 */
export async function createCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/** Random 32-byte OAuth `state` (CSRF protection), base64url-encoded. */
export function createOAuthState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
