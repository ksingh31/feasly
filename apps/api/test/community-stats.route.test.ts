/**
 * Community-stats route tests (neighbourhood/01).
 *
 * Covers: happy path (snake_case contract, integer dollars, fresh → stale
 * false), stale flag (45-day bound), RFC 7807 404 with COMMUNITY_NOT_FOUND,
 * 400 on malformed slugs, and the Socrata-internals deny list on the
 * serialized response.
 */
import { describe, expect, it } from 'vitest';
import {
  createCommunityStatsRoute,
  STALE_AFTER_DAYS,
} from '../src/routes/community-stats.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type {
  CommunityStatRecord,
  CommunityStatsService,
} from '../src/services/community-stats.service';

const RECORD: CommunityStatRecord = {
  slug: 'mount-pleasant',
  name: 'Mount Pleasant',
  avgAssessedValue: 685000,
  assessmentCount: 3210,
  avgLotSqft: 5432,
  refreshedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
};

function serviceWith(record: CommunityStatRecord | null): CommunityStatsService {
  return {
    getBySlug: async (slug: string) =>
      record && record.slug === slug ? record : null,
    upsertMany: async () => 0,
  };
}

describe('community-stats route', () => {
  it('returns the six contract fields with fresh data (stale false)', async () => {
    const route = createCommunityStatsRoute({
      communityStats: serviceWith(RECORD),
    });
    const res = await route.handle('mount-pleasant');
    expect(res).toEqual({
      slug: 'mount-pleasant',
      name: 'Mount Pleasant',
      avg_assessed_value: 685000,
      assessment_count: 3210,
      avg_lot_sqft: 5432,
      refreshed_at: RECORD.refreshedAt.toISOString(),
      stale: false,
    });
    expect(Number.isInteger(res.avg_assessed_value)).toBe(true);
  });

  it('flags stale when refreshed_at is older than 45 days', async () => {
    const old: CommunityStatRecord = {
      ...RECORD,
      refreshedAt: new Date(
        Date.now() - (STALE_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000,
      ),
    };
    const route = createCommunityStatsRoute({
      communityStats: serviceWith(old),
    });
    const res = await route.handle('mount-pleasant');
    expect(res.stale).toBe(true);
    expect(res.refreshed_at).toBe(old.refreshedAt.toISOString());
  });

  it('throws 404 COMMUNITY_NOT_FOUND for an unknown slug', async () => {
    const route = createCommunityStatsRoute({
      communityStats: serviceWith(null),
    });
    const error = await route
      .handle('no-such-place')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
    expect((error as HttpError).code).toBe(ErrorCodes.COMMUNITY_NOT_FOUND);
  });

  it.each(['', 'Mount Pleasant', 'MOUNT-PLEASANT', 'a b', '../x', 42, null])(
    'rejects malformed slug %p with 400',
    async (slug) => {
      const route = createCommunityStatsRoute({
        communityStats: serviceWith(RECORD),
      });
      const error = await route.handle(slug).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe(ErrorCodes.VALIDATION_FAILED);
    },
  );

  it('serialized response contains no raw Socrata internals', async () => {
    const route = createCommunityStatsRoute({
      communityStats: serviceWith(RECORD),
    });
    const json = JSON.stringify(await route.handle('mount-pleasant'));
    for (const banned of [
      'comm_name',
      'assessed_value',
      'land_size_sf',
      'roll_year',
      'mod_date',
    ]) {
      // avg_assessed_value is the public contract field — the raw Socrata
      // column name `assessed_value` must not appear as its own key.
      if (banned === 'assessed_value') {
        expect(json).not.toMatch(/"assessed_value"\s*:/);
      } else {
        expect(json).not.toContain(banned);
      }
    }
  });
});
