/**
 * Cookie-credential CSRF origin check (#794, #731 F-6, pen-test P-14).
 *
 * Admin/builder session cookies are `HttpOnly; Secure; SameSite=None`
 * (required for the cross-origin SPA), so a cross-site `<form
 * method=POST>` — a CORS "simple" request with no preflight — would carry
 * them in browsers that still send third-party cookies. Bearer-header auth
 * (which the SPA uses first) is immune: a cross-site form cannot set
 * `Authorization`.
 *
 * Rule: when the request's session credential would come from a cookie
 * (no `Authorization: Bearer` header, and an admin/builder session cookie
 * present) and the method is state-changing (not GET/HEAD/OPTIONS), the
 * `Origin` header — or, when absent, the `Referer` header's origin — must
 * be in the CORS allowlist (`CORS_ORIGINS`). Otherwise the request is
 * denied (the pipeline maps that to 403 + audit).
 *
 * The cookie-vs-bearer decision mirrors `session-token.ts` exactly: every
 * guard and the AuthContextService prefer a well-formed Bearer token and
 * never fall back to the cookie when one is present, so a request with a
 * Bearer header cannot be authenticated by an ambient cookie.
 *
 * Pure: no I/O. The allowlist arrives as an argument (config.ts owns it;
 * this module never embeds literal origins — test/boundaries.test.ts).
 */
import {
  ADMIN_SESSION_COOKIE,
  BUILDER_SESSION_COOKIE,
  parseBearerToken,
  parseCookieValue,
  type HeaderRecord,
} from './session-token';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfDenyReason = 'origin_missing' | 'origin_not_allowed';

export type CsrfVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: CsrfDenyReason;
      /** Which session cookie would have authenticated the request. */
      readonly cookie: 'admin' | 'builder';
    };

function firstValue(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

/** `Origin` header, else the origin of `Referer`. Undefined when neither parses. */
export function requestOrigin(headers: HeaderRecord): string | undefined {
  const origin = firstValue(headers['origin']);
  // `Origin: null` (sandboxed iframes, some redirects) is an opaque origin —
  // never allowlistable; treat it as present-but-not-allowed.
  if (origin) return origin;
  const referer = firstValue(headers['referer']);
  if (!referer) return undefined;
  try {
    const parsed = new URL(referer);
    if (parsed.origin === 'null') return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether a request may proceed. `method` undefined is treated as
 * state-changing (fail closed).
 */
export function checkCookieCsrf(args: {
  readonly method: string | undefined;
  readonly headers: HeaderRecord;
  readonly allowlist: readonly string[];
}): CsrfVerdict {
  const { method, headers, allowlist } = args;
  if (method && SAFE_METHODS.has(method.toUpperCase())) return { allowed: true };
  // Bearer wins over the cookie everywhere — the cookie is never consulted.
  if (parseBearerToken(headers)) return { allowed: true };
  const cookie: 'admin' | 'builder' | null = parseCookieValue(headers, ADMIN_SESSION_COOKIE)
    ? 'admin'
    : parseCookieValue(headers, BUILDER_SESSION_COOKIE)
      ? 'builder'
      : null;
  if (!cookie) return { allowed: true };

  const origin = requestOrigin(headers);
  if (!origin) return { allowed: false, reason: 'origin_missing', cookie };
  const lower = origin.toLowerCase();
  const ok = allowlist.some((allowed) => allowed.toLowerCase() === lower);
  return ok ? { allowed: true } : { allowed: false, reason: 'origin_not_allowed', cookie };
}
