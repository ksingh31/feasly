#!/usr/bin/env npx tsx
/**
 * Seed `community_stats` from the City of Calgary property assessment
 * dataset (neighbourhood/01).
 *
 * Cache-first by design: this one-time backfill (and the monthly refresh
 * timer in `neighbourhood/05`) pulls Socrata aggregates so the API never
 * calls Socrata per-request.
 *
 * - Idempotent: rows are upserted on `slug`; run it twice → same rows.
 * - Aggregation logic lives in the shared helper
 *   (`src/services/community-stats/socrata-aggregates.ts`) — the SEO
 *   community-data pipeline (`seo/03`) must use the same helper, never
 *   duplicated SoQL/SQL.
 *
 * Dataset: https://data.calgary.ca/resource/4bsw-nn7w.json (public, no key).
 *
 * Run: `npm run db:seed:community-stats --workspace @feasly/api`
 * (DATABASE_URL or POSTGRES_* must be set, same as `db:migrate`).
 */
import { createDbClient } from '../src/db/client';
import { createDrizzleCommunityStatsService } from '../src/services/community-stats.service';
import {
  SocrataAggregateRow,
  buildAggregatesSoql,
  toCommunityStatRecord,
} from '../src/services/community-stats/socrata-aggregates';
import { resolveDatabaseUrl } from './db-url.mjs';

const DATASET = 'https://data.calgary.ca/resource/4bsw-nn7w.json';
// Mirror the API config defaults (config.ts communityStatsRefresh) so the
// seed and the timer write exactly the same set of rows.
const MIN_ASSESSMENTS = Number(process.env.COMMUNITY_STATS_MIN_ASSESSMENTS ?? 10);
const PRUNE_MIN_ROWS = Number(process.env.COMMUNITY_STATS_PRUNE_MIN_ROWS ?? 100);

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'feasly-community-stats-seed/1.0' },
  });
  if (!res.ok) {
    throw new Error(`Socrata request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function latestRollYear(): Promise<string> {
  const rows = (await fetchJson(
    `${DATASET}?$select=roll_year&$order=roll_year DESC&$limit=1`,
  )) as Array<{ roll_year?: string }>;
  const year = rows[0]?.roll_year;
  if (!year) throw new Error('could not determine latest roll_year');
  return year;
}

async function main(): Promise<void> {
  const rollYear = await latestRollYear();
  console.log(`latest roll_year: ${rollYear}`);

  const rows = (await fetchJson(
    `${DATASET}?${buildAggregatesSoql(rollYear)}`,
  )) as unknown[];
  console.log(`aggregate rows: ${rows.length}`);

  const refreshedAt = new Date();
  const records = [];
  let skipped = 0;
  for (const raw of rows) {
    const parsed = SocrataAggregateRow.safeParse(raw);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    try {
      const record = toCommunityStatRecord(parsed.data, refreshedAt);
      // Same thin-data rule as the refresh timer: never write a community
      // with too few assessments (#468 — the seed previously had no floor).
      if (record.assessmentCount < MIN_ASSESSMENTS) {
        skipped++;
        continue;
      }
      records.push(record);
    } catch {
      skipped++;
    }
  }
  console.log(`usable: ${records.length}, skipped: ${skipped}`);

  const { db, close } = createDbClient({
    connectionString: resolveDatabaseUrl('db:seed:community-stats'),
    maxPoolSize: 2,
  });
  try {
    const service = createDrizzleCommunityStatsService({ db });
    const written = await service.upsertMany(records);
    console.log(`upserted ${written} community_stats rows`);
    if (written >= PRUNE_MIN_ROWS) {
      const pruned = await service.deleteRefreshedBefore(refreshedAt);
      console.log(`pruned ${pruned} row(s) the current definition no longer produces`);
    } else {
      console.log(`prune skipped (${written} rows < floor ${PRUNE_MIN_ROWS})`);
    }
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
