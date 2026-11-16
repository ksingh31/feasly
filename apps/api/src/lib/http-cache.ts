/**
 * HTTP caching helpers for public GETs (#756).
 *
 * Property responses are public City data that only change when the City
 * republishes, so the browser may reuse them (`Cache-Control: max-age`) and
 * revalidate cheaply (`ETag` / `If-None-Match` → 304). The routes are metered
 * per API key, so responses are `private` (browser cache only — a shared
 * cache must never answer for the meter) and always carry `Vary: Origin`
 * (CORS headers differ per origin). Pure — no I/O.
 */
import { createHash } from 'node:crypto';

/** Weak ETag over the JSON body (semantic equality, not byte equality). */
export function weakEtag(body: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('base64url');
  return `W/"${digest.slice(0, 27)}"`;
}

/** Strips the weak prefix so W/"x" and "x" compare equal (weak comparison). */
function opaque(tag: string): string {
  const t = tag.trim();
  return t.startsWith('W/') ? t.slice(2) : t;
}

/**
 * True when an `If-None-Match` header matches `etag` (RFC 9110 §13.1.2:
 * weak comparison, comma-separated list, `*` matches any).
 */
export function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const target = opaque(etag);
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .some((part) => part === '*' || opaque(part) === target);
}

/** `Cache-Control` for a browser-only, revalidatable response. */
export function privateCacheControl(maxAgeSeconds: number): string {
  return `private, max-age=${maxAgeSeconds}`;
}

/** Status, caching headers and (for 200) body of a cacheable JSON GET. */
export interface CacheableResponse {
  readonly status: 200 | 304;
  readonly headers: {
    readonly ETag: string;
    readonly 'Cache-Control': string;
    readonly Vary: 'Origin';
  };
  /** Undefined on 304 — the client reuses its cached copy. */
  readonly body: unknown;
}

/**
 * 200 with `ETag` + `Cache-Control`, or 304 (no body) when the request's
 * `If-None-Match` already names the current representation.
 */
export function cacheableResponse(
  body: unknown,
  ifNoneMatch: string | string[] | undefined,
  maxAgeSeconds: number,
): CacheableResponse {
  const etag = weakEtag(body);
  const headers = {
    ETag: etag,
    'Cache-Control': privateCacheControl(maxAgeSeconds),
    Vary: 'Origin' as const,
  };
  return ifNoneMatchHits(ifNoneMatch, etag)
    ? { status: 304, headers, body: undefined }
    : { status: 200, headers, body };
}
