/**
 * Embed origin parsing (#870). Pure — no I/O.
 *
 * An embed origin is a scheme + host (+ port) the widget may load on, e.g.
 * `https://www.builder.com`. https only, except plain-http localhost for
 * local development (mirrors the builders.allowed_origins rule). Paths,
 * queries, fragments and credentials are rejected so an origin can never
 * smuggle a page URL (or anything personal) into storage.
 */

/** Longest origin accepted (scheme + host + port). */
export const EMBED_ORIGIN_MAX_LENGTH = 255;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalize `value` to a canonical origin (`URL.origin`: lowercased host,
 * default port dropped). Returns null when it is not a valid embed origin.
 * A single trailing slash is tolerated (`https://a.com/` → `https://a.com`).
 */
export function parseEmbedOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > EMBED_ORIGIN_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const isHttps = url.protocol === 'https:';
  const isLocalHttp = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (!isHttps && !isLocalHttp) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  // `new URL('https://a.com?')` parses with an empty search — reject the
  // raw form too so only a bare origin (optionally with one '/') passes.
  if (/[?#]/.test(trimmed) || /\/\/.*\/./.test(trimmed)) return null;
  if (url.hostname === '') return null;
  return url.origin;
}
