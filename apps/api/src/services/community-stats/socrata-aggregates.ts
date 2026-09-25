/**
 * Shared community-stats aggregation helper (neighbourhood/01).
 *
 * This is the canonical place where City of Calgary assessment rows become
 * community aggregates. Both the API seed script
 * (`tools/seed-community-stats.mjs`) and the SEO community-data pipeline
 * (`seo/03`) MUST use these functions — never duplicated SoQL/SQL.
 *
 * Source dataset: Socrata `4bsw-nn7w` (Property Assessment), columns
 * `comm_name`, `assessed_value`, `land_size_sf`, `roll_year`.
 */
import { z } from 'zod';

/** One SoQL aggregate row: `comm_name, count(*), avg(assessed_value), avg(land_size_sf)` grouped by community. */
export const SocrataAggregateRow = z.object({
  comm_name: z.string(),
  count_assessed_value: z.coerce.number(),
  avg_assessed_value: z.coerce.number(),
  avg_land_size_sf: z.coerce.number().nullable().optional(),
});
export type SocrataAggregateRow = z.infer<typeof SocrataAggregateRow>;

/**
 * Canonical row written to `community_stats` / consumed by the SEO build.
 * Money is whole CAD dollars (City-assessed value, NOT market value).
 */
export interface CommunityStatRecord {
  readonly slug: string;
  readonly name: string;
  readonly avgAssessedValue: number;
  readonly assessmentCount: number;
  readonly avgLotSqft: number | null;
  readonly refreshedAt: Date;
}

/**
 * URL-safe community key: lowercase, whitespace/underscores → hyphens,
 * everything else stripped. Deterministic — the same `comm_name` always
 * yields the same slug, so the seed is idempotent and the API lookup is
 * stable.
 */
export function toSlug(communityName: string): string {
  return communityName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function toIntOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value);
}

/**
 * Map one validated SoQL aggregate row to a canonical record.
 * Throws on unusable rows (blank community name, no usable count) so the
 * seed skips them loudly instead of writing garbage.
 */
export function toCommunityStatRecord(
  row: SocrataAggregateRow,
  refreshedAt: Date,
): CommunityStatRecord {
  const name = row.comm_name.trim();
  const slug = toSlug(name);
  if (!name || !slug) {
    throw new Error(`unusable community row: ${JSON.stringify(row.comm_name)}`);
  }
  const count = Math.round(row.count_assessed_value);
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(`unusable assessment count for ${name}`);
  }
  if (!Number.isFinite(row.avg_assessed_value) || row.avg_assessed_value < 0) {
    throw new Error(`unusable avg assessed value for ${name}`);
  }
  return {
    slug,
    name,
    avgAssessedValue: Math.round(row.avg_assessed_value),
    assessmentCount: count,
    avgLotSqft: toIntOrNull(row.avg_land_size_sf),
    refreshedAt,
  };
}

/**
 * SoQL for the aggregate query. `rollYear` pins one assessment roll so the
 * averages are coherent; callers fetch the latest roll first.
 */
export function buildAggregatesSoql(rollYear: string): string {
  const params = new URLSearchParams({
    $select:
      'comm_name,count(assessed_value) as count_assessed_value,' +
      'avg(assessed_value) as avg_assessed_value,' +
      'avg(land_size_sf) as avg_land_size_sf',
    $where: `roll_year='${rollYear}' AND comm_name IS NOT NULL AND assessed_value > 0`,
    $group: 'comm_name',
    $limit: '50000',
  });
  return params.toString();
}
