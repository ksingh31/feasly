#!/usr/bin/env tsx
/**
 * SEO-03: Community data build script.
 *
 * Regenerates per-community statistics (record count, average assessed value,
 * average lot size) from real City of Calgary data and writes
 * `src/content/data/community-aggregates.json` for the prerendered community
 * pages (SEO-04) and llms.txt (SEO-07).
 *
 * Data paths (in order):
 *   1. `DATABASE_URL` set → the API's cached `properties` table (fast, no
 *      Socrata rate limits). If the table is unreachable, falls back to (2)
 *      with a warning.
 *   2. Direct Socrata read of `4bsw-nn7w` via a single SoQL GROUP BY query
 *      (anonymous, rate-limited — be polite, this runs at most once per day
 *      in practice because of the freshness skip below).
 *
 * Freshness: if the JSON already exists and `generatedAt` is < 30 days old,
 * the script skips regeneration (log + exit 0). Pass `--force` to override.
 * If regeneration fails and the on-disk JSON is stale or missing, the script
 * exits 1 with a "re-run the script" message — this is the CI staleness guard.
 *
 * Config (env, all optional):
 *   COMMUNITY_PAGE_LIMIT  top-N communities by record count (default 40)
 *   DATABASE_URL          Postgres connection string for the properties cache
 *   SOCRATA_BASE_URL      default https://data.calgary.ca
 *   SOCRATA_DATASET       default 4bsw-nn7w
 *   COST_DATA_VERSION     frozen engine version (default v0.1.0-unclibrated,
 *                         placeholder until ENG-005 calibration freezes v1)
 *
 * Usage: tsx apps/web/scripts/build-community-data.ts [--force]
 * Wired into the `@feasly/web` prebuild script.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  communityAggregatesFileSchema,
  scanDenyList,
} from './community-aggregates.schema.js';
import type {
  CommunityAggregate,
  CommunityAggregatesFile,
} from './community-aggregates.schema.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(SCRIPT_DIR, '..', 'src', 'content', 'data', 'community-aggregates.json');

/** Max age of the checked-in JSON before it must be regenerated. */
const MAX_AGE_DAYS = 30;
/** Socrata rows to pull; deliberately above the page limit so filtering still leaves enough. */
const FETCH_LIMIT = 100;
/** Hard cap on communities written, even if the limit is raised. */
const ABSOLUTE_MAX_COMMUNITIES = 200;

export interface BuildConfig {
  readonly pageLimit: number;
  readonly databaseUrl: string | undefined;
  readonly socrataBaseUrl: string;
  readonly socrataDataset: string;
  readonly costDataVersion: string;
  readonly force: boolean;
}

export function loadConfig(argv: readonly string[] = process.argv.slice(2)): BuildConfig {
  const rawLimit = (process.env['COMMUNITY_PAGE_LIMIT'] ?? '40').trim();
  const pageLimit = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(pageLimit) || pageLimit < 1) {
    throw new Error(
      `build-community-data: invalid COMMUNITY_PAGE_LIMIT ${JSON.stringify(rawLimit)} (expected a positive integer)`,
    );
  }
  return {
    pageLimit: Math.min(pageLimit, ABSOLUTE_MAX_COMMUNITIES),
    databaseUrl: process.env['DATABASE_URL']?.trim() || undefined,
    socrataBaseUrl: (process.env['SOCRATA_BASE_URL'] ?? 'https://data.calgary.ca').trim().replace(/\/+$/, ''),
    socrataDataset: (process.env['SOCRATA_DATASET'] ?? '4bsw-nn7w').trim(),
    // Placeholder until ENG-005 calibration freezes v1 — the field exists regardless.
    costDataVersion: (process.env['COST_DATA_VERSION'] ?? 'v0.1.0-unclibrated').trim(),
    force: argv.includes('--force'),
  };
}

/** One raw aggregate row, either from Socrata or the properties cache. */
export interface RawAggregateRow {
  readonly commName: string | null | undefined;
  readonly count: string | number | null | undefined;
  readonly avgAssessedValue: string | number | null | undefined;
  readonly avgLotSqft: string | number | null | undefined;
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

/**
 * Single SoQL aggregation over the assessment dataset — the server does the
 * GROUP BY, so this is one HTTP request regardless of dataset size.
 */
export async function fetchFromSocrata(
  config: Pick<BuildConfig, 'socrataBaseUrl' | 'socrataDataset'>,
  fetchImpl: typeof fetch = fetch,
): Promise<RawAggregateRow[]> {
  const params = new URLSearchParams({
    $select: 'comm_name,count(*),avg(assessed_value),avg(land_size_sf)',
    $group: 'comm_name',
    $order: 'count(*) DESC',
    $limit: String(FETCH_LIMIT),
  });
  const url = `${config.socrataBaseUrl}/resource/${config.socrataDataset}.json?${params}`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Socrata request failed: HTTP ${res.status} for ${config.socrataDataset}`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error('Socrata request failed: expected a JSON array');
  return body.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      commName: typeof r['comm_name'] === 'string' ? r['comm_name'] : null,
      count: r['count'] as string | number | null | undefined,
      avgAssessedValue: r['avg_assessed_value'] as string | number | null | undefined,
      avgLotSqft: r['avg_land_size_sf'] as string | number | null | undefined,
    };
  });
}

/**
 * Properties-cache path. The `properties` table is owned by the API track
 * (neighbourhood/01); expected columns mirror the Socrata assessment dataset.
 * Throws when the table is unreachable — the caller falls back to Socrata.
 */
export async function fetchFromDatabase(databaseUrl: string): Promise<RawAggregateRow[]> {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    const result = await client.query(
      `SELECT comm_name,
              COUNT(*)::text AS count,
              AVG(assessed_value)::text AS avg_assessed_value,
              AVG(land_size_sf)::text AS avg_lot_sqft
         FROM properties
        WHERE comm_name IS NOT NULL AND comm_name <> ''
        GROUP BY comm_name
        ORDER BY COUNT(*) DESC
        LIMIT ${FETCH_LIMIT}`,
    );
    return result.rows.map((r: Record<string, unknown>) => ({
      commName: typeof r['comm_name'] === 'string' ? r['comm_name'] : null,
      count: r['count'] as string | null,
      avgAssessedValue: r['avg_assessed_value'] as string | null,
      avgLotSqft: r['avg_lot_sqft'] as string | null,
    }));
  } finally {
    await client.end().catch(() => undefined);
  }
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
 * Builds the top-N community aggregates. Slugs are kebab-case and unique —
 * on collision a numeric suffix is appended and a warning is logged.
 */
export function buildAggregates(
  rows: readonly RawAggregateRow[],
  limit: number,
  onWarn: (message: string) => void = console.warn,
): CommunityAggregate[] {
  const used = new Set<string>();
  const aggregates: CommunityAggregate[] = [];
  for (const row of rows) {
    if (aggregates.length >= limit) break;
    const name = (row.commName ?? '').trim();
    const count = toPositiveInt(row.count);
    const avgAssessedValue = toNonNegativeInt(row.avgAssessedValue);
    const avgLotSqft = toNonNegativeInt(row.avgLotSqft);
    if (!name || count === null || avgAssessedValue === null || avgLotSqft === null) continue;
    let slug = slugify(name);
    if (!slug) continue;
    if (used.has(slug)) {
      let suffix = 2;
      while (used.has(`${slug}-${suffix}`)) suffix++;
      onWarn(`build-community-data: slug collision for ${JSON.stringify(name)} — using ${slug}-${suffix}`);
      slug = `${slug}-${suffix}`;
    }
    used.add(slug);
    aggregates.push({ slug, name, count, avgAssessedValue, avgLotSqft });
  }
  return aggregates;
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
  config: Pick<BuildConfig, 'costDataVersion'>,
  outputPath: string = OUTPUT_PATH,
): CommunityAggregatesFile {
  const file: CommunityAggregatesFile = {
    generatedAt: new Date().toISOString(),
    costDataVersion: config.costDataVersion,
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
  if (!config.force && age !== null && age < MAX_AGE_DAYS) {
    console.log(
      `build-community-data: using cached community-aggregates.json (generated ${age.toFixed(1)} days ago, fresh for ${MAX_AGE_DAYS} days)`,
    );
    return;
  }
  if (config.force) console.log('build-community-data: --force: regenerating');

  let rows: RawAggregateRow[] | null = null;
  let source = 'socrata';
  if (config.databaseUrl) {
    try {
      rows = await fetchFromDatabase(config.databaseUrl);
      source = 'properties-cache';
    } catch (error) {
      console.warn(
        `build-community-data: properties-cache read failed (${error instanceof Error ? error.message : String(error)}) — falling back to Socrata`,
      );
    }
  }
  if (rows === null) {
    rows = await fetchFromSocrata(config);
  }
  console.log(`build-community-data: fetched ${rows.length} community rows via ${source}`);

  const aggregates = buildAggregates(rows, config.pageLimit);
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
    const age = ageInDays();
    if (age !== null && age < MAX_AGE_DAYS) {
      console.warn(
        `build-community-data: refresh failed (${error instanceof Error ? error.message : String(error)}) — continuing with cached JSON from ${age.toFixed(1)} days ago`,
      );
      return;
    }
    console.error(
      `build-community-data: FAILED and no fresh community-aggregates.json is available. ` +
        `Re-run the script manually once network access is available: tsx apps/web/scripts/build-community-data.ts --force`,
    );
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Only auto-run when executed directly (not when imported by the spec).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
