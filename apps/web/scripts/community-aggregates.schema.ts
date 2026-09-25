/**
 * SEO-03: Zod schema for the community-aggregates build artifact.
 *
 * Checked-in contract for `src/content/data/community-aggregates.json`.
 * Mirrors the `CommunityAggregate` / `CommunityAggregatesFile` interfaces in
 * `@feasly/contracts` (camelCase) — the generator writes it, the prerender
 * step (SEO-04) reads it.
 *
 * Per-sqft figures and margins must never appear here; the generator runs a
 * deny-list scan over the serialized JSON and fails the build on a hit.
 */
import { z } from 'zod';

/** kebab-case slug: lowercase alphanumerics separated by single dashes. */
const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be kebab-case');

export const communityAggregateSchema = z.object({
  slug: slugSchema,
  /** Display name as the City dataset spells it (e.g. "PANORAMA HILLS"). */
  name: z.string().min(1).max(120),
  /** Assessment record count — drives the top-N page selection. */
  count: z.number().int().positive(),
  /** Average City-assessed value, integer CAD. Never a range. */
  avgAssessedValue: z.number().int().nonnegative(),
  /** Average lot size in square feet, rounded to an integer. */
  avgLotSqft: z.number().int().nonnegative(),
});

export const communityAggregatesFileSchema = z.object({
  /** ISO-8601 timestamp of when the data was generated (UTC). */
  generatedAt: z.string().datetime({ offset: true }),
  /** Frozen engine version the figures were produced against (placeholder). */
  costDataVersion: z.string().min(1),
  communities: z.array(communityAggregateSchema).min(1),
});

export type CommunityAggregate = z.infer<typeof communityAggregateSchema>;
export type CommunityAggregatesFile = z.infer<typeof communityAggregatesFileSchema>;

/**
 * Forbidden terms for the deny-list scan (SEO-03 AC4, SEO-07 AC5).
 * Proprietary cost-model internals must never leak into public content files.
 * Matched case-insensitively against the serialized JSON.
 */
export const DENY_LIST: readonly string[] = [
  'per_sqft',
  'perSqft',
  'per-sqft',
  'margin',
  'param',
];

/**
 * Scans serialized JSON for deny-listed terms. Returns the offending terms
 * found (empty when clean). Case-insensitive substring match — the artifact's
 * known keys (generatedAt, costDataVersion, slug, name, count,
 * avgAssessedValue, avgLotSqft) contain none of these substrings.
 */
export function scanDenyList(json: string): string[] {
  const lowered = json.toLowerCase();
  return DENY_LIST.filter((term) => lowered.includes(term.toLowerCase()));
}
