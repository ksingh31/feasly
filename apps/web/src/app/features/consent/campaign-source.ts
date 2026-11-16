import {
  ANALYTICS_SOURCE_FIELD_MAX_LENGTH,
  type AnalyticsSource,
  type ClickIdType,
} from '@feasly/contracts';

/**
 * Campaign attribution parsing (#815, web half of #814).
 *
 * Reads the landing URL's `utm_*` parameters, which ad click-id parameter
 * was present (its *name* only — the click id value never leaves this
 * function), and the first external referrer host. Pure: no DOM, no
 * storage — the caller passes the query string and referrer in.
 *
 * Values are cleaned to what the API accepts (`AnalyticsSourceSchema` in
 * apps/api/src/lib/campaign-source.ts): trimmed, at most
 * {@link ANALYTICS_SOURCE_FIELD_MAX_LENGTH} chars, plain-text charset only.
 * A value outside that set is dropped rather than sent, because the ingest
 * endpoint rejects the whole event on one bad field.
 */

/** utm parameters we read, in contract field order. */
const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

/** Click-id parameter names, first match wins (mirrors the API's closed set). */
const CLICK_ID_TYPES: readonly ClickIdType[] = ['gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid'];

/** Same charset as the API: letters, digits, space and `_ . + ~ | : / ( ) -`. */
const SAFE_VALUE = /^[\p{L}\p{N} _.+~|:/()-]+$/u;

/** Hostname charset (a referrer host goes out as `utm_source`). */
const SAFE_HOST = /^[a-z0-9.-]+$/;

/**
 * utm_medium used when the session arrived from another site without utm
 * tags: the referrer host becomes `utm_source` (the contract has no
 * separate referrer field), and this marks it as a referral.
 */
export const REFERRAL_MEDIUM = 'referral';

export interface CapturedCampaignSource {
  /** Attribution to attach to events and the lead submit. Null = none. */
  readonly source: AnalyticsSource | null;
  /** Host of the first external referrer, or null (same-site / none). */
  readonly referrerHost: string | null;
}

function cleanValue(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value.length === 0 || value.length > ANALYTICS_SOURCE_FIELD_MAX_LENGTH) return undefined;
  return SAFE_VALUE.test(value) ? value : undefined;
}

/** Host of an external referrer; null when absent, unparsable, or our own site. */
export function externalReferrerHost(referrer: string, ownHost: string): string | null {
  if (!referrer) return null;
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host || host === ownHost.toLowerCase()) return null;
  if (host.length > ANALYTICS_SOURCE_FIELD_MAX_LENGTH || !SAFE_HOST.test(host)) return null;
  return host;
}

/**
 * Parses the landing URL query + referrer into campaign attribution.
 * utm tags win; with none, an external referrer host is recorded as a
 * referral source. Returns `source: null` when there is nothing to record.
 */
export function parseCampaignSource(
  search: string,
  referrer: string,
  ownHost: string,
): CapturedCampaignSource {
  const params = new URLSearchParams(search);
  const referrerHost = externalReferrerHost(referrer, ownHost);
  const source: { -readonly [K in keyof AnalyticsSource]: AnalyticsSource[K] } = {};
  for (const field of UTM_FIELDS) {
    const value = cleanValue(params.get(field));
    if (value !== undefined) source[field] = value;
  }
  const clickId = CLICK_ID_TYPES.find((name) => (params.get(name) ?? '').trim().length > 0);
  if (clickId !== undefined) source.click_id_type = clickId;
  if (source.utm_source === undefined && referrerHost !== null && !hasUtm(source)) {
    source.utm_source = referrerHost;
    source.utm_medium = REFERRAL_MEDIUM;
  }
  return { source: Object.keys(source).length > 0 ? source : null, referrerHost };
}

function hasUtm(source: AnalyticsSource): boolean {
  return UTM_FIELDS.some((field) => source[field] !== undefined);
}
