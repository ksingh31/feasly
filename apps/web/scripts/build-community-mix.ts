#!/usr/bin/env tsx
/**
 * SEO: Community dwelling-mix build script.
 *
 * Computes per-community dwelling mix from the City of Calgary property
 * assessment dataset (Socrata `4bsw-nn7w`) and writes
 * `src/content/data/community-mix.json`. The mix drives the community page
 * variant: condo/apartment-dominated communities get the honest
 * "property profile" page instead of a single-family build-cost guide.
 *
 * Classification rule (data-driven):
 *   multiFamily share of residential dwelling records > 60% → 'profile'
 * Buckets (from `sub_property_use`, triangulated 2026-09-25 — see workspace
 * `single-family-data-research.md`; only R110 is verified to production
 * standard, the rest are directional but the multi-family grouping is what
 * the rule needs):
 *   - singleDetached: R110 (single-detached dwelling — verified)
 *   - semiDuplex: R120, R121, R111 (semi-detached / duplex)
 *   - multiFamily: everything else residential (apartments, condos,
 *     townhouses, multi-residential)
 * Excluded from dwelling counts: `A*` sub-property-use codes (condo common
 * elements, parking, storage — not dwellings) and non-LI property types.
 *
 * Manual override: these slugs are ALWAYS 'profile' (belt-and-suspenders
 * for the communities Karan named; harmless when the data already agrees).
 *
 * Only the slugs in community-aggregates.json (the 40 page communities) are
 * classified. Like build-community-data.ts: 30-day freshness skip, `--force`
 * to override, fails closed when stale/missing and regeneration fails.
 *
 * Usage: tsx apps/web/scripts/build-community-mix.ts [--force]
 * Wired into the `@feasly/web` prebuild script (after build-community-data).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  communityMixFileSchema,
} from './community-mix.schema.js';
import { scanDenyList } from './community-aggregates.schema.js';
import { communityTypesFileSchema } from './community-mix.schema.js';
import type {
  CommunityDwellingMix,
  CommunityMixFile,
  CommunityTypesFile,
} from './community-mix.schema.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(SCRIPT_DIR, '..', 'src', 'content', 'data', 'community-mix.json');
/** Slim slug → page-type lookup written next to the full mix file. */
const TYPES_OUTPUT_PATH = join(SCRIPT_DIR, '..', 'src', 'content', 'data', 'community-types.json');
const AGGREGATES_PATH = join(SCRIPT_DIR, '..', 'src', 'content', 'data', 'community-aggregates.json');

/** Max age of the checked-in JSON before it must be regenerated. */
const MAX_AGE_DAYS = 30;

/** Multi-family share above which a community gets the profile page. */
export const PROFILE_MULTI_FAMILY_THRESHOLD = 0.6;

/** Slugs that are always 'profile', regardless of the computed share. */
export const PROFILE_OVERRIDE_SLUGS: readonly string[] = [
  'beltline',
  'downtown-commercial-core',
  'east-village',
];

/** sub_property_use codes for semi-detached / duplex dwellings. */
const SEMI_DUPLEX_CODES = new Set(['R120', 'R121', 'R111']);
/** The verified single-detached code. */
const SINGLE_DETACHED_CODE = 'R110';

export interface MixBuildConfig {
  readonly socrataBaseUrl: string;
  readonly socrataDataset: string;
  readonly force: boolean;
}

export function loadConfig(argv: readonly string[] = process.argv.slice(2)): MixBuildConfig {
  return {
    socrataBaseUrl: (process.env['SOCRATA_BASE_URL'] ?? 'https://data.calgary.ca').trim().replace(/\/+$/, ''),
    socrataDataset: (process.env['SOCRATA_DATASET'] ?? '4bsw-nn7w').trim(),
    force: argv.includes('--force'),
  };
}

/** One grouped Socrata row: community × sub_property_use → record count. */
export interface MixCountRow {
  readonly commName: string;
  readonly subPropertyUse: string;
  readonly count: number;
}

export async function latestRollYear(
  config: Pick<MixBuildConfig, 'socrataBaseUrl' | 'socrataDataset'>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const params = new URLSearchParams({ $select: 'roll_year', $order: 'roll_year DESC', $limit: '1' });
  const res = await fetchImpl(`${config.socrataBaseUrl}/resource/${config.socrataDataset}.json?${params}`);
  if (!res.ok) throw new Error(`Socrata roll_year request failed: HTTP ${res.status}`);
  const body = (await res.json()) as Array<{ roll_year?: string }>;
  const year = body[0]?.roll_year;
  if (!year) throw new Error('could not determine latest roll_year');
  return year;
}

/**
 * Single SoQL GROUP BY over (comm_name, sub_property_use) for residential,
 * improved properties on one roll. A-codes and non-dwelling records are
 * filtered client-side in `classifyCommunities` so the bucketing stays
 * testable without HTTP.
 */
export async function fetchMixCounts(
  config: Pick<MixBuildConfig, 'socrataBaseUrl' | 'socrataDataset'>,
  rollYear: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MixCountRow[]> {
  const params = new URLSearchParams({
    $select: 'comm_name,sub_property_use,count(*)',
    $where: `roll_year='${rollYear}' AND assessment_class='RE' AND property_type='LI'`,
    $group: 'comm_name,sub_property_use',
    $limit: '50000',
  });
  const res = await fetchImpl(
    `${config.socrataBaseUrl}/resource/${config.socrataDataset}.json?${params}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Socrata mix request failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error('Socrata mix request failed: expected a JSON array');
  return body.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      commName: typeof r['comm_name'] === 'string' ? r['comm_name'] : '',
      subPropertyUse: typeof r['sub_property_use'] === 'string' ? r['sub_property_use'] : '',
      count: Number(r['count'] ?? 0),
    };
  });
}

/** kebab-case slug from a City community name ("PANORAMA HILLS" → "panorama-hills"). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * Buckets raw counts into dwelling mixes and classifies each slug.
 * Pure function — all HTTP happens in the fetchers above.
 */
export function classifyCommunities(
  rows: readonly MixCountRow[],
  slugs: readonly string[],
  onWarn: (message: string) => void = console.warn,
): CommunityDwellingMix[] {
  const wanted = new Set(slugs);
  const buckets = new Map<string, { singleDetached: number; semiDuplex: number; multiFamily: number }>();
  for (const row of rows) {
    const slug = slugify(row.commName);
    if (!wanted.has(slug)) continue;
    if (!row.subPropertyUse || row.subPropertyUse.startsWith('A')) continue; // common elements / parking / storage
    if (!Number.isFinite(row.count) || row.count <= 0) continue;
    let b = buckets.get(slug);
    if (!b) {
      b = { singleDetached: 0, semiDuplex: 0, multiFamily: 0 };
      buckets.set(slug, b);
    }
    const n = Math.round(row.count);
    if (row.subPropertyUse === SINGLE_DETACHED_CODE) b.singleDetached += n;
    else if (SEMI_DUPLEX_CODES.has(row.subPropertyUse)) b.semiDuplex += n;
    else b.multiFamily += n;
  }
  return slugs.map((slug) => {
    const b = buckets.get(slug) ?? { singleDetached: 0, semiDuplex: 0, multiFamily: 0 };
    const dwellingUnits = b.singleDetached + b.semiDuplex + b.multiFamily;
    if (dwellingUnits === 0) {
      onWarn(`build-community-mix: no dwelling records for ${slug} — defaulting to build-guide`);
    }
    const multiShare = dwellingUnits > 0 ? b.multiFamily / dwellingUnits : 0;
    const mostCommonType =
      b.singleDetached >= b.semiDuplex && b.singleDetached >= b.multiFamily
        ? 'singleDetached'
        : b.semiDuplex >= b.multiFamily
          ? 'semiDuplex'
          : 'multiFamily';
    const communityType =
      PROFILE_OVERRIDE_SLUGS.includes(slug) || multiShare > PROFILE_MULTI_FAMILY_THRESHOLD
        ? 'profile'
        : 'build-guide';
    return {
      slug,
      communityType,
      dwellingUnits,
      mix: { ...b },
      mostCommonType,
    } satisfies CommunityDwellingMix;
  });
}

/** Days since the JSON was generated; null when unreadable or unparseable. */
export function ageInDays(outputPath: string = OUTPUT_PATH): number | null {
  if (!existsSync(outputPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(outputPath, 'utf8'));
    const result = communityMixFileSchema.safeParse(parsed);
    if (!result.success) return null;
    const generatedAt = new Date(result.data.generatedAt).getTime();
    if (Number.isNaN(generatedAt)) return null;
    return (Date.now() - generatedAt) / 86_400_000;
  } catch {
    return null;
  }
}

export function writeMix(
  mixes: readonly CommunityDwellingMix[],
  assessmentYear: string,
  outputPath: string = OUTPUT_PATH,
): CommunityMixFile {
  const file: CommunityMixFile = {
    generatedAt: new Date().toISOString(),
    assessmentYear,
    communities: [...mixes],
  };
  const parsed = communityMixFileSchema.safeParse(file);
  if (!parsed.success) {
    throw new Error(`build-community-mix: schema validation failed: ${parsed.error.message}`);
  }
  const serialized = JSON.stringify(parsed.data, null, 2) + '\n';
  const hits = scanDenyList(serialized);
  if (hits.length > 0) {
    throw new Error(
      `build-community-mix: deny-list hit in community-mix.json (${hits.join(', ')}) — proprietary cost-model terms must never appear in public content`,
    );
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized);
  writeTypesFile(parsed.data);
  return parsed.data;
}

/**
 * Writes the slim slug → page-type lookup next to the full mix file, so the
 * community index and variant chooser can import ~1 KB instead of ~10 KB.
 */
export function writeTypesFile(
  mixFile: CommunityMixFile,
  typesOutputPath: string = TYPES_OUTPUT_PATH,
): CommunityTypesFile {
  const typesFile: CommunityTypesFile = {
    generatedAt: mixFile.generatedAt,
    assessmentYear: mixFile.assessmentYear,
    types: Object.fromEntries(mixFile.communities.map((c) => [c.slug, c.communityType])),
  };
  const parsed = communityTypesFileSchema.safeParse(typesFile);
  if (!parsed.success) {
    throw new Error(`build-community-mix: types schema validation failed: ${parsed.error.message}`);
  }
  mkdirSync(dirname(typesOutputPath), { recursive: true });
  writeFileSync(typesOutputPath, JSON.stringify(parsed.data) + '\n');
  return parsed.data;
}

function readAggregateSlugs(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(AGGREGATES_PATH, 'utf8'));
  const communities = (parsed as { communities?: Array<{ slug?: string }> }).communities;
  if (!Array.isArray(communities)) throw new Error(`build-community-mix: cannot read slugs from ${AGGREGATES_PATH}`);
  return communities.map((c) => String(c.slug)).filter(Boolean);
}

export async function run(config: MixBuildConfig): Promise<void> {
  const age = ageInDays();
  if (!config.force && age !== null && age < MAX_AGE_DAYS) {
    console.log(
      `build-community-mix: using cached community-mix.json (generated ${age.toFixed(1)} days ago, fresh for ${MAX_AGE_DAYS} days)`,
    );
    return;
  }
  if (config.force) console.log('build-community-mix: --force: regenerating');

  const slugs = readAggregateSlugs();
  const rollYear = await latestRollYear(config);
  const rows = await fetchMixCounts(config, rollYear);
  console.log(`build-community-mix: fetched ${rows.length} community×use rows for roll ${rollYear}`);
  const mixes = classifyCommunities(rows, slugs);
  const profiles = mixes.filter((m) => m.communityType === 'profile').map((m) => m.slug);
  console.log(`build-community-mix: ${mixes.length} classified, profile: ${profiles.join(', ') || '(none)'}`);
  writeMix(mixes, rollYear);

  const finalAge = ageInDays();
  if (finalAge === null || finalAge >= MAX_AGE_DAYS) {
    throw new Error(
      'build-community-mix: community-mix.json is stale or unreadable after generation — re-run the script manually: tsx apps/web/scripts/build-community-mix.ts --force',
    );
  }
}

async function main(): Promise<void> {
  try {
    await run(loadConfig());
  } catch (error) {
    const age = ageInDays();
    if (age !== null && age < MAX_AGE_DAYS) {
      console.warn(
        `build-community-mix: refresh failed (${error instanceof Error ? error.message : String(error)}) — continuing with cached JSON from ${age.toFixed(1)} days ago`,
      );
      return;
    }
    console.error(
      `build-community-mix: FAILED and no fresh community-mix.json is available. ` +
        `Re-run the script manually once network access is available: tsx apps/web/scripts/build-community-mix.ts --force`,
    );
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Only auto-run when executed directly (not when imported by the spec).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
