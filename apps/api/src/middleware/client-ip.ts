/**
 * Client IP resolution (#729) — the ONE place that reads `X-Forwarded-For`.
 *
 * Every per-IP rate limit keys on the value returned here, so it must not be
 * caller-controlled. `X-Forwarded-For` is a comma-separated chain where each
 * hop APPENDS the address it received the connection from. The client can
 * pre-fill the header with anything, so the LEFT-most entries are spoofable;
 * the Azure Functions front end appends the real peer address on the RIGHT.
 * We therefore take the right-most entry (the platform-appended hop).
 *
 * Topology assumption (infra/bicep/main.bicep): the web app calls the
 * Function App directly, cross-origin — there is no other proxy in front
 * of the platform front end. If a proxy (Front Door, APIM, an SWA linked
 * backend) is ever added, its address becomes the right-most hop and this
 * helper must skip that trusted hop — revisit #729 before adding one.
 *
 * Function adapters must call this rather than parse the header themselves
 * (enforced by `test/boundaries.test.ts`).
 */
import { isIP } from 'node:net';

export type ClientIpHeaders =
  | Record<string, string | string[] | undefined>
  | undefined;

const FORWARDED_FOR = 'x-forwarded-for';

/**
 * Strip an optional port: App Service front ends may append `ip:port`
 * (`203.0.113.7:51234`, `[2001:db8::1]:443`). A bare IPv6 address has
 * several colons and is returned unchanged.
 */
function stripPort(entry: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
  if (bracketed?.[1]) return bracketed[1];
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(entry);
  if (v4WithPort?.[1]) return v4WithPort[1];
  return entry;
}

/** Find the header case-insensitively (the v3 host lowercases, tests may not). */
function forwardedForValue(headers: ClientIpHeaders): string | undefined {
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== FORWARDED_FOR || value === undefined) continue;
    return Array.isArray(value) ? value.join(',') : value;
  }
  return undefined;
}

/**
 * The caller's address as seen by the platform: the right-most
 * `X-Forwarded-For` entry, port stripped. `undefined` when the header is
 * absent or its trusted hop is not a valid IP (callers fall back to the
 * shared `unknown` bucket, which is the conservative choice).
 */
export function clientIpFromHeaders(headers: ClientIpHeaders): string | undefined {
  const raw = forwardedForValue(headers);
  if (raw === undefined) return undefined;
  const hops = raw
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  const last = hops[hops.length - 1];
  if (last === undefined) return undefined;
  const ip = stripPort(last);
  return isIP(ip) === 0 ? undefined : ip;
}
