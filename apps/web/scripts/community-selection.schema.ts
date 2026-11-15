/**
 * #690: Zod schema + loader for `scripts/config/community-selection.json`.
 *
 * Which communities get a guide page is config, per city — not code. The
 * build script (`build-community-data.ts`) applies the rule; changing the
 * JSON changes the page list with no code change.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SELECTION_PATH = join(SCRIPT_DIR, 'config', 'community-selection.json');

const nameList = z.array(z.string().trim().min(1));

export const citySelectionSchema = z.object({
  socrataBaseUrl: z.string().url(),
  assessmentDataset: z.string().min(1),
  boundariesDataset: z.string().min(1),
  /** Boundary class + community structure that qualify a community. */
  rule: z.object({ classes: nameList, structures: nameList }),
  /** Always included (spelled as the assessment roll's comm_name). */
  include: nameList,
  /** Never included, even when the rule or include list matches. */
  exclude: nameList,
  /** Also include the top-N communities by residential record count (0 = off). */
  topByCount: z.number().int().min(0).max(200),
  /** Minimum residential assessment records for a page. */
  minRecords: z.number().int().positive(),
  /**
   * `sub_property_use` prefixes that count as a dwelling unit (houses,
   * semi-detached, townhouses, condo units). Everything else on the
   * residential roll (whole rental or mixed-use buildings, commercial
   * space, condo parking/storage) is excluded from every community
   * average and the dwelling mix, so a $40M apartment building never
   * reads as one "home".
   */
  dwellingCodePrefixes: z.array(z.string().regex(/^[A-Z][A-Z0-9]*$/)).min(1),
  /** Records that build-guide averages are made of. */
  guide: z.object({
    /** Assessment `sub_property_use` codes: single-detached and semi-detached. */
    subPropertyUses: nameList.min(1),
    /** Fewer guide records than this → no guide averages, profile page only. */
    minRecords: z.number().int().positive(),
  }),
  /** Community structures shown as "established" on the index; the rest are "newer". */
  establishedStructures: nameList,
  /** Slugs that always get the property-profile page. */
  profileOverrides: z.array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)),
});

export const communitySelectionFileSchema = z
  .object({
    defaultCity: z.string().min(1),
    cities: z.record(z.string(), citySelectionSchema),
  })
  .refine((f) => f.defaultCity in f.cities, { message: 'defaultCity must be a key of cities' });

export type CitySelection = z.infer<typeof citySelectionSchema>;
export type CommunitySelectionFile = z.infer<typeof communitySelectionFileSchema>;

/**
 * Reads and validates the selection config, returning the city's block.
 * `city` defaults to the file's `defaultCity` (override: COMMUNITY_CITY env).
 */
export function loadCitySelection(
  path: string = DEFAULT_SELECTION_PATH,
  city: string | undefined = process.env['COMMUNITY_CITY']?.trim() || undefined,
): { city: string; selection: CitySelection } {
  const parsed = communitySelectionFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`community-selection: invalid config ${path}: ${parsed.error.message}`);
  }
  const key = city ?? parsed.data.defaultCity;
  const selection = parsed.data.cities[key];
  if (!selection) throw new Error(`community-selection: no config for city ${JSON.stringify(key)} in ${path}`);
  return { city: key, selection };
}

/** True when a `sub_property_use` code is a dwelling unit under the given prefixes. */
export function isDwellingCode(code: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => code.startsWith(prefix));
}
