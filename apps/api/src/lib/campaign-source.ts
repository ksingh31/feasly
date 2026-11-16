/**
 * #814 — campaign attribution (`AnalyticsSource`) validation and mapping.
 *
 * One definition of what a safe attribution value is, shared by the
 * analytics ingest (strict: a bad value is a 400, like any other shape
 * violation) and the lead capture (lenient: a bad field is dropped — a
 * weird UTM tag must never cost us a lead).
 *
 * PII discipline: values are length-capped and restricted to a plain-text
 * charset that excludes `@` (emails), `$` (dollar figures) and `%`/`=`/`&`
 * (raw query-string fragments). The click id *value* is never accepted —
 * only which parameter was present (`click_id_type`).
 *
 * Pure: no I/O, no env, no clock.
 */
import { z } from 'zod';
import {
  ANALYTICS_SOURCE_FIELD_MAX_LENGTH,
  type AnalyticsSource,
  type ClickIdType,
} from '@feasly/contracts';

/** Click-id parameter names we record. Mirrors the `ClickIdType` union. */
export const CLICK_ID_TYPES: readonly ClickIdType[] = [
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'fbclid',
];

/** Letters (any script), digits, space and `_ - . + ~ | : / ( )`. */
const SAFE_VALUE = /^[\p{L}\p{N} _.+~|:/()-]+$/u;

const utmValue = z
  .string()
  .trim()
  .min(1)
  .max(ANALYTICS_SOURCE_FIELD_MAX_LENGTH)
  .regex(SAFE_VALUE, { message: 'contains characters outside the allowed set' });

const clickIdType = z.enum(CLICK_ID_TYPES as [ClickIdType, ...ClickIdType[]]);

/** Strict, closed `AnalyticsSource` schema (unknown keys rejected). */
export const AnalyticsSourceSchema = z
  .object({
    utm_source: utmValue.optional(),
    utm_medium: utmValue.optional(),
    utm_campaign: utmValue.optional(),
    utm_term: utmValue.optional(),
    utm_content: utmValue.optional(),
    click_id_type: clickIdType.optional(),
  })
  .strict();

/** The six nullable attribution columns, camel-cased for Drizzle. */
export interface CampaignSourceColumns {
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  readonly utmTerm: string | null;
  readonly utmContent: string | null;
  readonly clickIdType: ClickIdType | null;
}

export const EMPTY_CAMPAIGN_SOURCE: CampaignSourceColumns = {
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmTerm: null,
  utmContent: null,
  clickIdType: null,
};

/** Map a validated `AnalyticsSource` (or absence) onto the columns. */
export function sourceToColumns(
  source: AnalyticsSource | undefined,
): CampaignSourceColumns {
  if (!source) return EMPTY_CAMPAIGN_SOURCE;
  return {
    utmSource: source.utm_source ?? null,
    utmMedium: source.utm_medium ?? null,
    utmCampaign: source.utm_campaign ?? null,
    utmTerm: source.utm_term ?? null,
    utmContent: source.utm_content ?? null,
    clickIdType: source.click_id_type ?? null,
  };
}

/**
 * Lenient parse for lead capture: keeps each field that passes the same
 * checks as the strict schema and drops the rest. Unknown keys and
 * non-object input are ignored. Never throws.
 */
export function sanitizeLeadSource(raw: unknown): CampaignSourceColumns {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return EMPTY_CAMPAIGN_SOURCE;
  }
  const r = raw as Record<string, unknown>;
  const text = (v: unknown): string | null => {
    const parsed = utmValue.safeParse(v);
    return parsed.success ? parsed.data : null;
  };
  const click = clickIdType.safeParse(r['click_id_type']);
  return {
    utmSource: text(r['utm_source']),
    utmMedium: text(r['utm_medium']),
    utmCampaign: text(r['utm_campaign']),
    utmTerm: text(r['utm_term']),
    utmContent: text(r['utm_content']),
    clickIdType: click.success ? click.data : null,
  };
}

/**
 * Columns → contract shape with only the set fields; null when nothing is
 * set (the admin detail shows "no attribution" rather than an empty object).
 */
export function columnsToSource(
  cols: CampaignSourceColumns,
): AnalyticsSource | null {
  const out: {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    utm_content?: string;
    click_id_type?: ClickIdType;
  } = {};
  if (cols.utmSource !== null) out.utm_source = cols.utmSource;
  if (cols.utmMedium !== null) out.utm_medium = cols.utmMedium;
  if (cols.utmCampaign !== null) out.utm_campaign = cols.utmCampaign;
  if (cols.utmTerm !== null) out.utm_term = cols.utmTerm;
  if (cols.utmContent !== null) out.utm_content = cols.utmContent;
  if (cols.clickIdType !== null) out.click_id_type = cols.clickIdType;
  return Object.keys(out).length === 0 ? null : out;
}
