#!/usr/bin/env tsx
/**
 * SEO-03 / #690: Community data build script.
 *
 * Decides which communities get a guide page and computes their statistics
 * (record count, average assessed value, average lot size) from real City of
 * Calgary data, writing `src/content/data/community-aggregates.json` for the
 * prerendered community pages (SEO-04), the index, sitemap and llms.txt.
 *
 * Selection is config, per city (`scripts/config/community-selection.json`):
 *   (boundary class AND community structure match the rule)
 *   OR on the include list OR in the top-N by residential record count,
 *   minus the exclude list, and only with >= minRecords residential records.
 * See `selectCommunities` — a pure function, unit-tested against config.
 *
 * Averages (#690, no condo or commercial records in a guide figure):
 *   - top level: single-detached + semi-detached homes only (the guide
 *     subPropertyUses), basis 'detached-semi';
 *   - when a community has fewer than guide.minRecords such homes, the top
 *     level falls back to all residential dwellings, basis 'residential',
 *     and build-community-mix forces the profile page (never a guide);
 *   - `residential`: every dwelling-unit record — the config's
 *     `dwellingCodePrefixes` (houses, semi-detached, townhouses, condo
 *     units). Whole rental/mixed-use buildings, commercial space and condo
 *     parking/storage are excluded, so one large building cannot skew a
 *     community average — the view profile pages show.
 *
 * Data: three anonymous Socrata reads (server-side GROUP BY, one request
 * each): community boundaries (`surr-xmvs`), and two aggregates over the
 * latest assessment roll (`4bsw-nn7w`).
 *
 * Freshness: if the JSON already exists and `generatedAt` is < 30 days old,
 * the script skips regeneration (log + exit 0). Pass `--force` to override.
 * The skip also requires the JSON to have been built from the current
 * selection config (a config edit regenerates on the next build).
 * If regeneration fails (e.g. data.calgary.ca unreachable) the build never
 * fails on that alone (#469): a stale on-disk JSON is used and the staleness
 * is surfaced as a warning (a `::warning::` annotation on GitHub Actions).
 * Only a missing/unreadable JSON exits 1 — see `snapshot-fallback.ts`.
 *
 * Config (env, all optional — the selection itself lives in the JSON config):
 *   COMMUNITY_CITY        city key in the selection config (default: its defaultCity)
 *   SOCRATA_BASE_URL      overrides the city's socrataBaseUrl
 *   SOCRATA_DATASET       overrides the city's assessmentDataset
 *   COST_DATA_VERSION     engine version label (default: the bundled engine
 *                         table's version, PLACEHOLDER_COST_DATA.version)
 *
 * Usage: tsx apps/web/scripts/build-community-data.ts [--force]
 * Wired into the `@feasly/web` prebuild script.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  communityAggregatesFileSchema,
  scanDenyList,
} from './community-aggregates.schema.js';
import type {
  CommunityAggregate,
  CommunityAggregatesFile,
} from './community-aggregates.schema.js';
import { PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import { loadCitySelection } from './community-selection.schema.js';
import type { CitySelection } from './community-selection.schema.js';

import { reportRefreshFailure, resolveRefreshFailure } from './snapshot-fallback.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(SCRIPT_DIR, '..', 'src', 'content', 'data', 'community-aggregates.json');

/** Max age of the checked-in JSON before it must be regenerated. */
const MAX_AGE_DAYS = 30;
/** Hard cap on communities written, whatever the config says (SWA config/file limits). */
export const ABSOLUTE_MAX_COMMUNITIES = 200;
/** Socrata rows per aggregate request — well above Calgary's ~300 communities. */
const SOCRATA_ROW_LIMIT = 5000;

export interface BuildConfig {
  readonly city: string;
  readonly selection: CitySelection;
  /** Stable hash of the city's selection config — a config edit invalidates the cache. */
  readonly selectionHash: string;
  readonly socrataBaseUrl: string;
  readonly socrataDataset: string;
  readonly boundariesDataset: string;
  readonly costDataVersion: string;
  readonly force: boolean;
}

export function loadConfig(
  argv: readonly string[] = process.argv.slice(2),
  selectionPath?: string,
): BuildConfig {
  const { city, selection } = loadCitySelection(selectionPath);
  return {
    city,
    selection,
    selectionHash: createHash('sha256').update(JSON.stringify({ city, selection })).digest('hex').slice(0, 16),
    socrataBaseUrl: (process.env['SOCRATA_BASE_URL'] ?? selection.socrataBaseUrl).trim().replace(/\/+$/, ''),
    socrataDataset: (process.env['SOCRATA_DATASET'] ?? selection.assessmentDataset).trim(),
    boundariesDataset: selection.boundariesDataset,
    // The engine table the published ranges come from (never a hand-typed literal).
    costDataVersion: (process.env['COST_DATA_VERSION'] ?? PLACEHOLDER_COST_DATA.version).trim(),
    force: argv.includes('--force'),
  };
}

/** One raw aggregate row from Socrata (strings, as SoQL returns them). */
export interface RawAggregateRow {
  readonly commName: string | null | undefined;
  readonly count: string | number | null | undefined;
  readonly avgAssessedValue: string | number | null | undefined;
  readonly avgLotSqft: string | number | null | undefined;
}

/** One community boundary row (`surr-xmvs`). */
export interface BoundaryRow {
  readonly name: string;
  readonly communityClass: string;
  readonly structure: string;
  readonly sector: string;
}

function toPositiveInt(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function toNonNegativeInt(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

async function getJsonArray(url: string, label: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>[]> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Socrata request failed: HTTP ${res.status} for ${label}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error(`Socrata request failed: expected a JSON array for ${label}`);
  return body as Record<string, unknown>[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Latest assessment roll year (the dataset carries one roll today; filter anyway). */
export async function latestRollYear(
  config: Pick<BuildConfig, 'socrataBaseUrl' | 'socrataDataset'>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const params = new URLSearchParams({ $select: 'roll_year', $order: 'roll_year DESC', $limit: '1' });
  const body = await getJsonArray(
    `${config.socrataBaseUrl}/resource/${config.socrataDataset}.json?${params}`,
    `${config.socrataDataset} roll_year`,
    fetchImpl,
  );
  const year = str(body[0]?.['roll_year']);
  if (!/^\d{4}$/.test(year)) throw new Error('could not determine latest roll_year');
  return year;
}

/** Community boundaries with class, structure and sector — one request. */
export async function fetchBoundaries(
  config: Pick<BuildConfig, 'socrataBaseUrl' | 'boundariesDataset'>,
  fetchImpl: typeof fetch = fetch,
): Promise<BoundaryRow[]> {
  const params = new URLSearchParams({
    $select: 'name,class,comm_structure,sector',
    $limit: String(SOCRATA_ROW_LIMIT),
  });
  const body = await getJsonArray(
    `${config.socrataBaseUrl}/resource/${config.boundariesDataset}.json?${params}`,
    config.boundariesDataset,
    fetchImpl,
  );
  return body
    .map((r) => ({
      name: str(r['name']),
      communityClass: str(r['class']),
      structure: str(r['comm_structure']),
      sector: str(r['sector']),
    }))
    .filter((r) => r.name.length > 0);
}

/** SoQL-quoted list of codes; codes are validated to plain tokens first. */
function soqlList(codes: readonly string[]): string {
  for (const c of codes) {
    if (!/^[A-Za-z0-9]+$/.test(c)) throw new Error(`invalid sub_property_use code ${JSON.stringify(c)}`);
  }
  return codes.map((c) => `'${c}'`).join(',');
}

/** Which records an aggregate is built from: exact codes, or code prefixes. */
export type UseFilter = { readonly codes: readonly string[] } | { readonly prefixes: readonly string[] };

/**
 * Residential-dwelling aggregates per community over one roll — one
 * server-side GROUP BY. `{ codes }` → only those `sub_property_use` codes
 * (the guide basis: single/semi-detached); `{ prefixes }` → every code
 * starting with one of them (the dwelling-unit allowlist from config).
 */
export async function fetchResidentialAggregates(
  config: Pick<BuildConfig, 'socrataBaseUrl' | 'socrataDataset'>,
  rollYear: string,
  filter: UseFilter,
  fetchImpl: typeof fetch = fetch,
): Promise<RawAggregateRow[]> {
  if (!/^\d{4}$/.test(rollYear)) throw new Error(`invalid roll year ${JSON.stringify(rollYear)}`);
  let useFilter: string;
  if ('codes' in filter) {
    useFilter = `sub_property_use in(${soqlList(filter.codes)})`;
  } else {
    if (filter.prefixes.length === 0) throw new Error('dwelling code prefix list is empty');
    soqlList(filter.prefixes); // validates each prefix is a plain token
    useFilter = `(${filter.prefixes.map((p) => `starts_with(sub_property_use, '${p}')`).join(' OR ')})`;
  }
  const params = new URLSearchParams({
    $select: 'comm_name,count(*),avg(assessed_value),avg(land_size_sf)',
    $where: `roll_year='${rollYear}' AND assessment_class='RE' AND property_type='LI' AND ${useFilter}`,
    $group: 'comm_name',
    $order: 'count(*) DESC',
    $limit: String(SOCRATA_ROW_LIMIT),
  });
  const body = await getJsonArray(
    `${config.socrataBaseUrl}/resource/${config.socrataDataset}.json?${params}`,
    config.socrataDataset,
    fetchImpl,
  );
  return body.map((r) => ({
    commName: typeof r['comm_name'] === 'string' ? r['comm_name'] : null,
    count: r['count'] as string | number | null | undefined,
    avgAssessedValue: r['avg_assessed_value'] as string | number | null | undefined,
    avgLotSqft: r['avg_land_size_sf'] as string | number | null | undefined,
  }));
}

/** kebab-case slug from a City community name ("PANORAMA HILLS" → "panorama-hills"). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

interface Averages {
  readonly count: number;
  readonly avgAssessedValue: number;
  readonly avgLotSqft: number;
}

function averagesByName(rows: readonly RawAggregateRow[]): Map<string, Averages> {
  const out = new Map<string, Averages>();
  for (const row of rows) {
    const name = (row.commName ?? '').trim().toUpperCase();
    const count = toPositiveInt(row.count);
    const avgAssessedValue = toNonNegativeInt(row.avgAssessedValue);
    const avgLotSqft = toNonNegativeInt(row.avgLotSqft);
    if (!name || count === null || avgAssessedValue === null || avgLotSqft === null) continue;
    out.set(name, { count, avgAssessedValue, avgLotSqft });
  }
  return out;
}

/**
 * #690: applies the city's selection config to the raw data. Pure — no I/O —
 * so a unit test can show that changing config changes the list.
 *
 * Output order: residential record count, largest first. Slugs are
 * kebab-case and unique (numeric suffix + warning on collision).
 */
export function selectCommunities(
  selection: CitySelection,
  boundaries: readonly BoundaryRow[],
  residentialRows: readonly RawAggregateRow[],
  guideRows: readonly RawAggregateRow[],
  onWarn: (message: string) => void = console.warn,
): CommunityAggregate[] {
  const upper = (xs: readonly string[]) => new Set(xs.map((x) => x.trim().toUpperCase()));
  const ruleClasses = upper(selection.rule.classes);
  const ruleStructures = upper(selection.rule.structures);
  const established = upper(selection.establishedStructures);
  const include = upper(selection.include);
  const exclude = upper(selection.exclude);

  const residential = averagesByName(residentialRows);
  const guide = averagesByName(guideRows);
  const boundaryByName = new Map(boundaries.map((b) => [b.name.trim().toUpperCase(), b]));

  const wanted = new Set<string>();
  for (const b of boundaryByName.values()) {
    if (ruleClasses.has(b.communityClass.toUpperCase()) && ruleStructures.has(b.structure.toUpperCase())) {
      wanted.add(b.name.trim().toUpperCase());
    }
  }
  for (const name of include) wanted.add(name);
  if (selection.topByCount > 0) {
    [...residential.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, selection.topByCount)
      .forEach(([name]) => wanted.add(name));
  }
  for (const name of exclude) wanted.delete(name);

  const candidates: Array<{ name: string; res: Averages }> = [];
  for (const name of wanted) {
    const res = residential.get(name);
    if (!res || res.count < selection.minRecords) {
      const why = include.has(name) ? ' (on the include list)' : '';
      onWarn(
        `build-community-data: ${JSON.stringify(name)}${why} has ${res?.count ?? 0} residential records (< ${selection.minRecords}) — no page`,
      );
      continue;
    }
    candidates.push({ name, res });
  }
  candidates.sort((a, b) => b.res.count - a.res.count || a.name.localeCompare(b.name));
  if (candidates.length > ABSOLUTE_MAX_COMMUNITIES) {
    onWarn(
      `build-community-data: ${candidates.length} communities selected — capped at ${ABSOLUTE_MAX_COMMUNITIES} (largest kept)`,
    );
    candidates.length = ABSOLUTE_MAX_COMMUNITIES;
  }

  const used = new Set<string>();
  const out: CommunityAggregate[] = [];
  for (const { name, res } of candidates) {
    let slug = slugify(name);
    if (!slug) continue;
    if (used.has(slug)) {
      let suffix = 2;
      while (used.has(`${slug}-${suffix}`)) suffix++;
      onWarn(`build-community-data: slug collision for ${JSON.stringify(name)} — using ${slug}-${suffix}`);
      slug = `${slug}-${suffix}`;
    }
    used.add(slug);
    const houses = guide.get(name);
    const guideOk = houses !== undefined && houses.count >= selection.guide.minRecords;
    const top = guideOk ? houses : res;
    const boundary = boundaryByName.get(name);
    out.push({
      slug,
      name,
      count: top.count,
      avgAssessedValue: top.avgAssessedValue,
      avgLotSqft: top.avgLotSqft,
      basis: guideOk ? 'detached-semi' : 'residential',
      group: boundary && established.has(boundary.structure.toUpperCase()) ? 'established' : 'newer',
      ...(boundary?.sector ? { sector: boundary.sector } : {}),
      residential: { ...res },
    });
  }
  return out;
}

/** The selection-config hash the on-disk JSON was built from (null when absent/unreadable). */
export function cachedSelectionHash(outputPath: string = OUTPUT_PATH): string | null {
  if (!existsSync(outputPath)) return null;
  try {
    const result = communityAggregatesFileSchema.safeParse(JSON.parse(readFileSync(outputPath, 'utf8')));
    return result.success ? (result.data.selectionHash ?? null) : null;
  } catch {
    return null;
  }
}

/** Days since the JSON was generated; null when unreadable or unparseable. */
export function ageInDays(outputPath: string = OUTPUT_PATH): number | null {
  if (!existsSync(outputPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(outputPath, 'utf8'));
    const result = communityAggregatesFileSchema.safeParse(parsed);
    if (!result.success) return null;
    const generatedAt = new Date(result.data.generatedAt).getTime();
    if (Number.isNaN(generatedAt)) return null;
    return (Date.now() - generatedAt) / 86_400_000;
  } catch {
    return null;
  }
}

/**
 * Writes the JSON after zod validation + deny-list scan. Throws with a clear
 * message on any failure so the build breaks loudly, never silently.
 */
export function writeAggregates(
  aggregates: readonly CommunityAggregate[],
  config: Pick<BuildConfig, 'costDataVersion' | 'selectionHash'>,
  outputPath: string = OUTPUT_PATH,
): CommunityAggregatesFile {
  const file: CommunityAggregatesFile = {
    generatedAt: new Date().toISOString(),
    costDataVersion: config.costDataVersion,
    selectionHash: config.selectionHash,
    communities: [...aggregates],
  };
  const parsed = communityAggregatesFileSchema.safeParse(file);
  if (!parsed.success) {
    throw new Error(`build-community-data: schema validation failed: ${parsed.error.message}`);
  }
  const serialized = JSON.stringify(parsed.data, null, 2) + '\n';
  const hits = scanDenyList(serialized);
  if (hits.length > 0) {
    throw new Error(
      `build-community-data: deny-list hit in community-aggregates.json (${hits.join(', ')}) — proprietary cost-model terms must never appear in public content`,
    );
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized);
  return parsed.data;
}

export async function run(config: BuildConfig): Promise<void> {
  const age = ageInDays();
  const sameSelection = cachedSelectionHash() === config.selectionHash;
  if (!config.force && sameSelection && age !== null && age < MAX_AGE_DAYS) {
    console.log(
      `build-community-data: using cached community-aggregates.json (generated ${age.toFixed(1)} days ago, fresh for ${MAX_AGE_DAYS} days)`,
    );
    return;
  }
  if (config.force) console.log('build-community-data: --force: regenerating');
  else if (!sameSelection) console.log('build-community-data: selection config changed — regenerating');

  const rollYear = await latestRollYear(config);
  const [boundaries, residentialRows, guideRows] = await Promise.all([
    fetchBoundaries(config),
    fetchResidentialAggregates(config, rollYear, { prefixes: config.selection.dwellingCodePrefixes }),
    fetchResidentialAggregates(config, rollYear, { codes: config.selection.guide.subPropertyUses }),
  ]);
  console.log(
    `build-community-data: roll ${rollYear}: ${boundaries.length} boundaries, ${residentialRows.length} residential and ${guideRows.length} detached/semi community rows (city=${config.city})`,
  );

  const aggregates = selectCommunities(config.selection, boundaries, residentialRows, guideRows);
  if (aggregates.length === 0) {
    throw new Error('build-community-data: no usable community rows — refusing to write an empty file');
  }
  const file = writeAggregates(aggregates, config);
  console.log(
    `build-community-data: wrote ${file.communities.length} communities to ${OUTPUT_PATH} (cost_data_version=${file.costDataVersion})`,
  );

  // Staleness guard: the file we just wrote must be fresh, or fail loudly.
  const finalAge = ageInDays();
  if (finalAge === null || finalAge >= MAX_AGE_DAYS) {
    throw new Error(
      'build-community-data: community-aggregates.json is stale or unreadable after generation — re-run the script manually: tsx apps/web/scripts/build-community-data.ts --force',
    );
  }
}

async function main(): Promise<void> {
  try {
    await run(loadConfig());
  } catch (error) {
    // #469: a network failure never fails the build on its own — a stale
    // snapshot is used with a warning; only a missing/unreadable one fails.
    const outcome = resolveRefreshFailure({
      label: 'build-community-data',
      fileName: 'community-aggregates.json',
      age: ageInDays(),
      maxAgeDays: MAX_AGE_DAYS,
      error,
      scriptPath: 'apps/web/scripts/build-community-data.ts',
    });
    const code = reportRefreshFailure(outcome);
    if (code !== 0) process.exit(code);
  }
}

// Only auto-run when executed directly (not when imported by the spec).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
