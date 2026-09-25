/**
 * SEO-04: Zod schema for the community-ranges build artifact.
 *
 * Checked-in contract for `src/content/data/community-ranges.json`.
 * This file contains ONLY public figures (integer-dollar range bands per
 * finish tier) — it is bundled into the web app and prerendered HTML, so it
 * must never contain per-sqft rates, margins, or calibration parameters.
 * The generator (build-community-ranges.ts) runs the deny-list scan over
 * the serialized JSON and fails the build on a hit.
 */
import { z } from 'zod';

/** kebab-case slug: lowercase alphanumerics separated by single dashes. */
const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be kebab-case');

const tierRangeSchema = z.object({
  /** Build-cost range, whole CAD dollars (engine spreads, never a point figure). */
  buildLow: z.number().int().nonnegative(),
  buildHigh: z.number().int().nonnegative(),
  /** Fixed City-assessed land value, whole CAD dollars — never a range. */
  landValue: z.number().int().nonnegative(),
  /** Total = land + build, whole CAD dollars. */
  totalLow: z.number().int().nonnegative(),
  totalHigh: z.number().int().nonnegative(),
});

export const communityRangesSchema = z.object({
  slug: slugSchema,
  tiers: z.object({
    standard: tierRangeSchema,
    premium: tierRangeSchema,
    luxury: tierRangeSchema,
  }),
});

export const communityRangesFileSchema = z.object({
  /** ISO-8601 timestamp of when the ranges were generated (UTC). */
  generatedAt: z.string().datetime({ offset: true }),
  /** Frozen engine version the ranges were computed with. */
  costDataVersion: z.string().min(1),
  /** False until Karan's real cost Sheet calibrates a successor table. */
  calibrated: z.boolean(),
  /** Above-grade living area (sqft) the build ranges assume. */
  buildSqft: z.number().int().positive(),
  communities: z.array(communityRangesSchema).min(1),
});

export type CommunityTierRange = z.infer<typeof tierRangeSchema>;
export type CommunityRanges = z.infer<typeof communityRangesSchema>;
export type CommunityRangesFile = z.infer<typeof communityRangesFileSchema>;

/**
 * Forbidden terms for the deny-list scan (SEO-04 AC7).
 * Proprietary cost-model internals must never leak into public content files.
 * Matched case-insensitively against the serialized JSON.
 */
export const RANGES_DENY_LIST: readonly string[] = [
  'per_sqft',
  'perSqft',
  'per-sqft',
  'margin',
  'param',
];

/**
 * Scans serialized JSON for deny-listed terms. Returns the offending terms
 * found (empty when clean). The artifact's known keys (generatedAt,
 * costDataVersion, calibrated, buildSqft, slug, tiers, standard, premium,
 * luxury, buildLow, buildHigh, landValue, totalLow, totalHigh) contain none
 * of these substrings.
 */
export function scanDenyListRanges(json: string): string[] {
  const lowered = json.toLowerCase();
  return RANGES_DENY_LIST.filter((term) => lowered.includes(term.toLowerCase()));
}
