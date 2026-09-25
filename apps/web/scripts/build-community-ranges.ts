#!/usr/bin/env tsx
/**
 * SEO-04: Community cost-range build script.
 *
 * Runs the FROZEN cost engine (@feasly/cost-engine) over each community's
 * aggregates and writes `src/content/data/community-ranges.json` — public
 * range bands per finish tier for the prerendered community pages.
 *
 * CRITICAL: This script runs in Node at build time. The cost engine's
 * per-sqft rates, margins, and calibration parameters NEVER leave this
 * process: the output JSON contains only integer-dollar range bands
 * (buildLow/buildHigh/totalLow/totalHigh) and the fixed assessed land
 * value. The Angular component reads the JSON; it never imports the engine
 * (packages/cost-engine explicitly forbids apps/web imports).
 *
 * Per community × tier (standard|premium|luxury):
 *   createEstimate(
 *     { property: { assessedLandValue, lotSizeSqft, zoning: 'R-CG' },
 *       scope: { buildSqft: 2400, tier } },
 *     PLACEHOLDER_COST_DATA,  // frozen until ENG-005 calibration lands
 *   )
 * Land is the City-assessed value (fixed, no spread — engine invariant).
 * Build/total carry the engine's spreads.
 *
 * Also refreshes `prerender-routes.txt` with the `/communities/{slug}/`
 * routes so `ng build` prerenders all community pages.
 *
 * Config (env, all optional):
 *   BUILD_SQFT  above-grade living area the ranges assume (default 2400)
 *
 * Usage: tsx apps/web/scripts/build-community-ranges.ts [--force]
 * Wired into the `@feasly/web` prebuild script (after build-community-data).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEstimate,
  PLACEHOLDER_COST_DATA,
  type FinishTier,
} from '@feasly/cost-engine';
import type { CommunityRangesFile } from './community-ranges.schema.js';
import {
  communityAggregatesFileSchema,
} from './community-aggregates.schema.js';
import {
  communityRangesFileSchema,
  scanDenyListRanges,
} from './community-ranges.schema.js';
import type { CommunityRanges } from './community-ranges.schema.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGGREGATES_PATH = join(SCRIPT_DIR, '..', 'src', 'content', 'data', 'community-aggregates.json');
const OUTPUT_PATH = join(SCRIPT_DIR, '..', 'src', 'content', 'data', 'community-ranges.json');
const PRERENDER_ROUTES_PATH = join(SCRIPT_DIR, '..', 'prerender-routes.txt');

const TIERS: readonly FinishTier[] = ['standard', 'premium', 'luxury'];
/** Placeholder zoning for community-level estimates (no per-address zoning). */
const COMMUNITY_ZONING = 'R-CG';

export function loadBuildSqft(): number {
  const raw = (process.env['BUILD_SQFT'] ?? '2400').trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 500 || n > 20000) {
    throw new Error(`build-community-ranges: invalid BUILD_SQFT ${JSON.stringify(raw)} (expected 500–20000)`);
  }
  return n;
}

/**
 * Computes the public range bands for one community × tier using the frozen
 * engine. Returns ONLY public figures — no rates, no params.
 *
 * The community's average lot size can exceed the engine's single-lot input
 * bounds (e.g. downtown averages skewed by large commercial parcels); it is
 * clamped into bounds with a logged warning. The assessed land value is
 * always passed through untouched — it is a City fact, not an estimate.
 */
export function rangesForCommunity(
  assessedLandValue: number,
  lotSizeSqft: number,
  tier: FinishTier,
  buildSqft: number,
  onWarn: (message: string) => void = console.warn,
): { ranges: CommunityRanges['tiers']['standard']; calibrated: boolean } {
  const bounds = PLACEHOLDER_COST_DATA.inputBounds;
  const clampedLot = Math.min(Math.max(Math.round(lotSizeSqft), bounds.minLotSizeSqft), bounds.maxLotSizeSqft);
  if (clampedLot !== Math.round(lotSizeSqft)) {
    onWarn(
      `build-community-ranges: lot size ${Math.round(lotSizeSqft)} sqft outside engine bounds — clamped to ${clampedLot} sqft`,
    );
  }
  const result = createEstimate(
    {
      property: { assessedLandValue, lotSizeSqft: clampedLot, zoning: COMMUNITY_ZONING },
      scope: { buildSqft, tier },
    },
    PLACEHOLDER_COST_DATA,
  );
  return {
    ranges: {
      buildLow: result.totals.build.low,
      buildHigh: result.totals.build.high,
      landValue: result.totals.land.value,
      totalLow: result.totals.total.low,
      totalHigh: result.totals.total.high,
    },
    calibrated: result.calibrated,
  };
}

export function buildRangesFile(buildSqft: number): CommunityRangesFile {
  if (!existsSync(AGGREGATES_PATH)) {
    throw new Error(`build-community-ranges: aggregates JSON not found at ${AGGREGATES_PATH} — run build-community-data.ts first`);
  }
  const aggregatesRaw: unknown = JSON.parse(readFileSync(AGGREGATES_PATH, 'utf8'));
  const aggregates = communityAggregatesFileSchema.parse(aggregatesRaw);

  // The engine reports calibration state; the frozen table is uncalibrated
  // until ENG-005 lands — surface it so pages can show the illustrative banner.
  let calibrated = false;
  const communities: CommunityRanges[] = aggregates.communities.map((c, i) => {
    const standard = rangesForCommunity(c.avgAssessedValue, c.avgLotSqft, 'standard', buildSqft);
    const premium = rangesForCommunity(c.avgAssessedValue, c.avgLotSqft, 'premium', buildSqft);
    const luxury = rangesForCommunity(c.avgAssessedValue, c.avgLotSqft, 'luxury', buildSqft);
    if (i === 0) calibrated = standard.calibrated;
    return {
      slug: c.slug,
      tiers: { standard: standard.ranges, premium: premium.ranges, luxury: luxury.ranges },
    };
  });
  const file: CommunityRangesFile = {
    generatedAt: new Date().toISOString(),
    costDataVersion: PLACEHOLDER_COST_DATA.version,
    calibrated,
    buildSqft,
    communities,
  };
  const parsed = communityRangesFileSchema.safeParse(file);
  if (!parsed.success) {
    throw new Error(`build-community-ranges: schema validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function writeRangesFile(file: CommunityRangesFile, outputPath: string = OUTPUT_PATH): void {
  const serialized = JSON.stringify(file, null, 2) + '\n';
  const hits = scanDenyListRanges(serialized);
  if (hits.length > 0) {
    throw new Error(
      `build-community-ranges: deny-list hit in community-ranges.json (${hits.join(', ')}) — proprietary cost-model terms must never appear in public content`,
    );
  }
  writeFileSync(outputPath, serialized);
  console.log(`build-community-ranges: wrote ${file.communities.length} communities × 3 tiers to ${outputPath}`);
}

/**
 * Refreshes prerender-routes.txt: keeps all hand-maintained routes, replaces
 * any stale `/communities/*` lines with the fresh slug list.
 */
export function refreshPrerenderRoutes(slugs: readonly string[], routesPath: string = PRERENDER_ROUTES_PATH): void {
  const existing = existsSync(routesPath) ? readFileSync(routesPath, 'utf8') : '';
  const kept = existing
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('/communities/'));
  for (const slug of slugs) {
    kept.push(`/communities/${slug}/`);
  }
  writeFileSync(routesPath, kept.join('\n') + '\n');
  console.log(`build-community-ranges: refreshed ${routesPath} with ${slugs.length} community routes`);
}

async function main(): Promise<void> {
  const force = process.argv.slice(2).includes('--force');
  const buildSqft = loadBuildSqft();

  // Skip when the ranges are fresh relative to the aggregates.
  if (!force && existsSync(OUTPUT_PATH) && existsSync(AGGREGATES_PATH)) {
    const rangesRaw: unknown = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
    const rangesParsed = communityRangesFileSchema.safeParse(rangesRaw);
    const aggRaw: unknown = JSON.parse(readFileSync(AGGREGATES_PATH, 'utf8'));
    const aggParsed = communityAggregatesFileSchema.safeParse(aggRaw);
    if (rangesParsed.success && aggParsed.success) {
      const rangesTime = new Date(rangesParsed.data.generatedAt).getTime();
      const aggTime = new Date(aggParsed.data.generatedAt).getTime();
      if (rangesTime >= aggTime && rangesParsed.data.buildSqft === buildSqft) {
        console.log('build-community-ranges: ranges are fresh relative to aggregates — skipping (use --force to override)');
        refreshPrerenderRoutes(rangesParsed.data.communities.map((c) => c.slug));
        return;
      }
    }
  }

  const file = buildRangesFile(buildSqft);
  writeRangesFile(file);
  refreshPrerenderRoutes(file.communities.map((c) => c.slug));
}

// Only auto-run when executed directly (not when imported by the spec).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('build-community-ranges: FAILED');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
