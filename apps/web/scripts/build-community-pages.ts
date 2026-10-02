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
 * The index page (`/communities`) still static-imports the full aggregates
 * (it lists all 40), so that import stays.
 *
 * Usage: tsx apps/web/scripts/build-community-pages.ts
 * Wired into the `@feasly/web` prebuild script (after build-community-ranges).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nearbyCommunities } from '../src/app/core/community/nearby-communities.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(SCRIPT_DIR, '..', 'src', 'content', 'data');
const OUTPUT_DIR = join(DATA_DIR, 'community-pages');

interface AggregateRow {
  slug: string;
  name: string;
  count: number;
  avgAssessedValue: number;
  avgLotSqft: number;
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

  const aggregates = readJson<{ communities: AggregateRow[] }>(aggregatesPath).communities;
  const ranges = readJson<{
    communities: Array<{ slug: string; tiers: unknown[]; costDataVersion: string; calibrated: boolean; buildSqft: number }>;
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

  mkdirSync(OUTPUT_DIR, { recursive: true });

  let written = 0;
  for (const agg of aggregates) {
    const slug = agg.slug;
    const type = typeBySlug.get(slug) ?? 'build-guide';
    const range = rangesBySlug.get(slug) ?? null;
    const nearbySlugs = nearbyCommunities(slug, aggregates, 3);
    const nearby: NearbyEntry[] = nearbySlugs
      .map((s) => aggregateBySlug.get(s))
      .filter((a): a is AggregateRow => !!a)
      .map((a) => ({ slug: a.slug, name: a.name }));

    const pageData: Record<string, unknown> = {
      slug,
      type,
      assessmentYear,
      aggregate: agg,
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

  console.log(`build-community-pages: wrote ${written} per-slug files to ${OUTPUT_DIR}`);
}

main();
