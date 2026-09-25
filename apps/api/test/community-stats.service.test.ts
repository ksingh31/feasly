/**
 * Community-stats service + seed-idempotency tests (neighbourhood/01).
 *
 * The drizzle service runs against PGlite with the real migrations applied.
 * Covers: getBySlug hit/miss and upsertMany idempotency (run twice → same
 * rows — the seed script's core guarantee).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createDrizzleCommunityStatsService,
  type CommunityStatRecord,
} from '../src/services/community-stats.service';
import { createTestDb, type TestDb } from './pglite-db';

const ROWS: CommunityStatRecord[] = [
  {
    slug: 'mount-pleasant',
    name: 'Mount Pleasant',
    avgAssessedValue: 685000,
    assessmentCount: 3210,
    avgLotSqft: 5432,
    refreshedAt: new Date('2026-09-25T00:00:00Z'),
  },
  {
    slug: 'bridgeland-riverside',
    name: 'Bridgeland/Riverside',
    avgAssessedValue: 712500,
    assessmentCount: 1980,
    avgLotSqft: null,
    refreshedAt: new Date('2026-09-25T00:00:00Z'),
  },
];

describe('community-stats service', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    // PGlite WASM init + migrations can exceed vitest's 10s default hook
    // timeout on cold/loaded machines.
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('upserts rows and returns them by slug', async () => {
    const service = createDrizzleCommunityStatsService({ db: testDb.db });
    expect(await service.upsertMany(ROWS)).toBe(2);

    const hit = await service.getBySlug('mount-pleasant');
    expect(hit).toMatchObject({
      slug: 'mount-pleasant',
      name: 'Mount Pleasant',
      avgAssessedValue: 685000,
      assessmentCount: 3210,
      avgLotSqft: 5432,
    });

    const nullLot = await service.getBySlug('bridgeland-riverside');
    expect(nullLot?.avgLotSqft).toBeNull();

    expect(await service.getBySlug('no-such-place')).toBeNull();
  });

  it('is idempotent: run twice → same rows', async () => {
    const service = createDrizzleCommunityStatsService({ db: testDb.db });
    await service.upsertMany(ROWS);
    const before = await testDb.rows<{ slug: string }>(
      'SELECT slug, name, avg_assessed_value, assessment_count FROM community_stats ORDER BY slug',
    );
    await service.upsertMany(ROWS);
    const after = await testDb.rows<{ slug: string }>(
      'SELECT slug, name, avg_assessed_value, assessment_count FROM community_stats ORDER BY slug',
    );
    expect(after).toEqual(before);
    expect(after).toHaveLength(2);
  });

  it('updates changed values on re-upsert', async () => {
    const service = createDrizzleCommunityStatsService({ db: testDb.db });
    await service.upsertMany(ROWS);
    const updated: CommunityStatRecord = {
      ...ROWS[0],
      avgAssessedValue: 690000,
      refreshedAt: new Date('2026-09-26T00:00:00Z'),
    };
    await service.upsertMany([updated]);
    const hit = await service.getBySlug('mount-pleasant');
    expect(hit?.avgAssessedValue).toBe(690000);
  });
});
