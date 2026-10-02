/**
 * SEO: Zod schema for the community dwelling-mix build artifact.
 *
 * Checked-in contract for `src/content/data/community-mix.json`.
 * Mirrors the `CommunityDwellingMix` / `CommunityMixFile` interfaces in
 * `@feasly/contracts` (camelCase) — the generator writes it, the community
 * pages (guide vs property-profile variant) read it at prerender.
 */
import { z } from 'zod';

/** kebab-case slug: lowercase alphanumerics separated by single dashes. */
const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be kebab-case');

export const communityTypeSchema = z.enum(['build-guide', 'profile']);

export const dwellingBucketSchema = z.enum(['singleDetached', 'semiDuplex', 'multiFamily']);

export const communityDwellingMixSchema = z.object({
  slug: slugSchema,
  communityType: communityTypeSchema,
  /** Residential dwelling assessment records (excludes common elements/parking/storage). */
  dwellingUnits: z.number().int().positive(),
  mix: z.object({
    singleDetached: z.number().int().nonnegative(),
    semiDuplex: z.number().int().nonnegative(),
    multiFamily: z.number().int().nonnegative(),
  }),
  mostCommonType: dwellingBucketSchema,
});

export const communityMixFileSchema = z.object({
  /** ISO-8601 timestamp of when the data was generated (UTC). */
  generatedAt: z.string().datetime({ offset: true }),
  /** Assessment roll year the mix was computed from, e.g. "2026". */
  assessmentYear: z.string().regex(/^\d{4}$/),
  communities: z.array(communityDwellingMixSchema).min(1),
});

export type CommunityDwellingMix = z.infer<typeof communityDwellingMixSchema>;
export type CommunityMixFile = z.infer<typeof communityMixFileSchema>;
