#!/usr/bin/env tsx
/**
 * SEO: Community per-slug page-data build script.
 *
 * Reads the already-generated `community-aggregates.json`,
 * `community-ranges.json`, `community-mix.json`, and `community-types.json`
 * and emits one small JSON per community page:
 * `src/content/data/community-pages/<slug>.json`.
 *
 * Each file contains ONLY what its page needs:
 *   - the community's aggregate row
 *   - the community's range row (build-guide pages)
 *   - the 3-4 nearby communities' minimal rows (slug + name for links)
 *   - the page type ('build-guide' | 'profile')
 *   - the dwelling mix (profile pages only)
 *
 * Why: the community page component previously static-imported the full
 * aggregates (40 communities) and ranges (40 communities) JSONs, bundling
 * ~15KB of data into the client JS. With per-slug files, the component
 * dynamically imports only its own ~0.5KB file — the route chunk shrinks
 * and the shared aggregates chunk is no longer loaded by slug pages.
 *
 * #690: profile pages show the community's all-residential averages
 * (condos included); build-guide pages show the single/semi-detached
 * averages. The index (`/communities/`) and the mock API static-import the
 * slim `community-index.json` written here (slug, name, type, group and
 * the figures the page shows) instead of the full aggregates.
 *
 * Usage: tsx apps/web/scripts/build-community-pages.ts
 * Wired into the `@feasly/web` prebuild script (after build-community-ranges).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommunityIndexEntry, CommunityIndexFile } from '@feasly/contracts';
import { nearbyCommunities } from '../src/app/core/community/nearby-communities.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(SCRIPT_DIR, '..', 'src', 'content', 'data');
const OUTPUT_DIR = join(DATA_DIR, 'community-pages');
const INDEX_PATH = join(DATA_DIR, 'community-index.json');

interface Averages {
  count: number;
  avgAssessedValue: number;
  avgLotSqft: number;
}

interface AggregateRow extends Averages {
  slug: string;
  name: string;
  basis?: 'detached-semi' | 'residential';
  group?: 'established' | 'newer';
  sector?: string;
  residential?: Averages;
}

/**
 * The aggregate a page shows. Profile pages use the all-residential view;
 * guide pages the single/semi-detached one. A guide is never built on a
 * residential-basis average (build-community-mix forces those to profile);
 * this throws if the generated files ever disagree.
 */
export function pageAggregate(agg: AggregateRow, type: string): AggregateRow {
  if (type === 'profile') {
    const view: Averages = agg.residential ?? agg;
    return {
      slug: agg.slug,
      name: agg.name,
      count: view.count,
      avgAssessedValue: view.avgAssessedValue,
      avgLotSqft: view.avgLotSqft,
    };
  }
  if (agg.basis === 'residential') {
    throw new Error(
      `build-community-pages: ${agg.slug} is a build guide but its averages include condo records — re-run build-community-mix.ts --force`,
    );
  }
  return { slug: agg.slug, name: agg.name, count: agg.count, avgAssessedValue: agg.avgAssessedValue, avgLotSqft: agg.avgLotSqft };
}

interface NearbyEntry {
  slug: string;
  name: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function main(): void {
  const aggregatesPath = join(DATA_DIR, 'community-aggregates.json');
  const rangesPath = join(DATA_DIR, 'community-ranges.json');
  const mixPath = join(DATA_DIR, 'community-mix.json');
  const typesPath = join(DATA_DIR, 'community-types.json');

  for (const p of [aggregatesPath, rangesPath, typesPath]) {
    if (!existsSync(p)) {
      console.error(`build-community-pages: missing ${p} — run the community data generators first`);
      process.exit(1);
    }
  }

  const aggregatesFile = readJson<{ generatedAt: string; communities: AggregateRow[] }>(aggregatesPath);
  const aggregates = aggregatesFile.communities;
  const ranges = readJson<{
    communities: Array<{ slug: string; tiers: unknown }>;
    costDataVersion?: string;
    calibrated?: boolean;
    buildSqft?: number;
  }>(rangesPath);
  const rangesBySlug = new Map(ranges.communities.map((r) => [r.slug, r]));
  const types = readJson<{ types: Record<string, string> }>(typesPath);
  const typeBySlug = new Map(Object.entries(types.types));
  const mixBySlug: Map<string, unknown> = existsSync(mixPath)
    ? new Map(
        (readJson<{ communities: Array<Record<string, unknown>> }>(mixPath).communities.map((m) => [
          m['slug'] as string,
          m,
        ]) as Array<[string, unknown]>),
      )
    : new Map<string, unknown>();
  const assessmentYear = existsSync(mixPath)
    ? (readJson<{ assessmentYear?: string }>(mixPath).assessmentYear ?? '')
    : '';

  const aggregateBySlug = new Map(aggregates.map((a) => [a.slug, a]));

  // Start clean so a community dropped from the selection leaves no orphan file.
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  let written = 0;
  const index: CommunityIndexEntry[] = [];
  for (const agg of aggregates) {
    const slug = agg.slug;
    const type = typeBySlug.get(slug) ?? 'build-guide';
    const view = pageAggregate(agg, type);
    index.push({
      slug,
      name: agg.name,
      type: type === 'profile' ? 'profile' : 'build-guide',
      group: agg.group ?? 'newer',
      count: view.count,
      avgAssessedValue: view.avgAssessedValue,
      avgLotSqft: view.avgLotSqft,
    });
    // The version/calibration/sqft fields live once at the top of the ranges
    // file; each page's range row carries them so the page can state them
    // (feasly:cost-data-version meta, illustrative banner).
    const row = rangesBySlug.get(slug);
    const range = row
      ? {
          ...row,
          costDataVersion: ranges.costDataVersion ?? '',
          calibrated: ranges.calibrated ?? false,
          buildSqft: ranges.buildSqft ?? 0,
        }
      : null;
    const nearbySlugs = nearbyCommunities(slug, aggregates, 3);
    const nearby: NearbyEntry[] = nearbySlugs
      .map((s) => aggregateBySlug.get(s))
      .filter((a): a is AggregateRow => !!a)
      .map((a) => ({ slug: a.slug, name: a.name }));

    const pageData: Record<string, unknown> = {
      slug,
      type,
      assessmentYear,
      aggregate: view,
      range,
      nearby,
    };
    if (type === 'profile') {
      const mix = mixBySlug.get(slug);
      if (mix) pageData['mix'] = mix;
    }

    writeFileSync(join(OUTPUT_DIR, `${slug}.json`), JSON.stringify(pageData));
    written++;
  }

  const indexFile: CommunityIndexFile = { generatedAt: aggregatesFile.generatedAt, communities: index };
  writeFileSync(INDEX_PATH, JSON.stringify(indexFile) + '\n');
  console.log(`build-community-pages: wrote ${written} per-slug files to ${OUTPUT_DIR} and ${index.length} index entries`);
}

// Only auto-run when executed directly (not when imported by a spec).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
