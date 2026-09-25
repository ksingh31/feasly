/**
 * Shared aggregation-helper tests (neighbourhood/01).
 *
 * This helper is the single source of truth for community aggregates —
 * the seed script and the SEO pipeline (`seo/03`) both consume it.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAggregatesSoql,
  SocrataAggregateRow,
  toCommunityStatRecord,
  toSlug,
} from '../src/services/community-stats/socrata-aggregates';

describe('toSlug', () => {
  it.each([
    ['Mount Pleasant', 'mount-pleasant'],
    ['Bridgeland/Riverside', 'bridgeland-riverside'],
    ['  Beltline  ', 'beltline'],
    ['Sunnyside_Hill', 'sunnyside-hill'],
    ['A-B', 'a-b'],
  ])('%p → %p', (name, slug) => {
    expect(toSlug(name)).toBe(slug);
  });
});

describe('toCommunityStatRecord', () => {
  const refreshedAt = new Date('2026-09-25T00:00:00Z');

  it('rounds averages to whole dollars and counts to ints', () => {
    const record = toCommunityStatRecord(
      SocrataAggregateRow.parse({
        comm_name: 'Mount Pleasant',
        count_assessed_value: '3210',
        avg_assessed_value: '685000.6',
        avg_land_size_sf: '5432.4',
      }),
      refreshedAt,
    );
    expect(record).toEqual({
      slug: 'mount-pleasant',
      name: 'Mount Pleasant',
      avgAssessedValue: 685001,
      assessmentCount: 3210,
      avgLotSqft: 5432,
      refreshedAt,
    });
  });

  it('keeps null lot size when the dataset lacks it', () => {
    const record = toCommunityStatRecord(
      SocrataAggregateRow.parse({
        comm_name: 'Downtown',
        count_assessed_value: 500,
        avg_assessed_value: 450000,
        avg_land_size_sf: null,
      }),
      refreshedAt,
    );
    expect(record.avgLotSqft).toBeNull();
  });

  it('rejects unusable rows loudly', () => {
    expect(() =>
      toCommunityStatRecord(
        SocrataAggregateRow.parse({
          comm_name: '   ',
          count_assessed_value: 10,
          avg_assessed_value: 100,
          avg_land_size_sf: null,
        }),
        refreshedAt,
      ),
    ).toThrow();
    expect(() =>
      toCommunityStatRecord(
        SocrataAggregateRow.parse({
          comm_name: 'Ghost Town',
          count_assessed_value: 0,
          avg_assessed_value: 100,
          avg_land_size_sf: null,
        }),
        refreshedAt,
      ),
    ).toThrow();
  });
});

describe('buildAggregatesSoql', () => {
  it('pins one roll year and groups by community', () => {
    // URLSearchParams percent-encodes the SoQL — decode before asserting.
    const soql = decodeURIComponent(buildAggregatesSoql('2025'));
    expect(soql).toContain('comm_name');
    expect(soql).toContain("roll_year='2025'");
    expect(soql).toContain('avg(assessed_value)');
  });

  it('filters to single-family (R110) parcels only', () => {
    // R110 = single-detached dwelling, identified empirically 2026-09-25
    // (see workspace single-family-data-research.md).
    const soql = decodeURIComponent(buildAggregatesSoql('2025'));
    expect(soql).toContain("assessment_class='RE'");
    expect(soql).toContain("property_type='LI'");
    expect(soql).toContain("sub_property_use='R110'");
  });
});
