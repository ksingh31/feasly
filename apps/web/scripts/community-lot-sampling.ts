/**
 * FE6-004: Neighbourhood lot price from sampled lots.
 *
 * Shared sampling module for build-time lot price figures. Queries the City
 * of Calgary assessment dataset (Socrata `4bsw-nn7w` or the API's `properties`
 * cache) for vacant residential parcels and teardown-proxy houses per
 * community, then computes a deterministic average.
 *
 * Sampling strategy (from Altadore research, 2026-09-25):
 *   1. Vacant residential lots: `property_type='LO' AND assessment_class='RE'`
 *      (direct land measurement — preferred).
 *   2. Teardown proxy: `property_type='LI' AND assessment_class='RE'` with
 *      `year_of_construction <= current_year - ageYears` (old single-family
 *      houses whose land value dominates).
 *
 * Outlier guards (research-proven):
 *   - Exclude parcels with `land_size_sf < 1000` (remnant strips/slivers).
 *   - Exclude non-residential `land_use_designation` (MU-1, MU-2, M-C2, etc.)
 *     — multi-unit development parcels skew the average.
 *
 * Deterministic: SoQL `ORDER BY assessed_value` + stable in-code sort.
 * Same dataset → same output. No LLM involvement in any dollar figure.
 *
 * Figures are assessed values only — never framed as market or sold prices.
 *
 * Config (env, all optional):
 *   LOT_SAMPLE_CAP        max sampled lots per community (default 10)
 *   LOT_SAMPLE_MIN        minimum for 'sampled-lots'; below → fallback (default 5)
 *   LOT_SAMPLE_AGE_YEARS  teardown-proxy age threshold (default 30)
 */

export interface LotSamplingConfig {
  /** Max sampled lots per community. */
  readonly cap: number;
  /** Minimum samples for 'sampled-lots'; below this → 'community-average' fallback. */
  readonly min: number;
  /** Teardown-proxy age threshold in years. */
  readonly ageYears: number;
}

export interface LotSample {
  /** Property address (e.g. "918 16 AV NW"). */
  readonly address: string;
  /** City-assessed value in CAD (integer). */
  readonly assessedValue: number;
  /** Lot size in square feet (may be null if unknown). */
  readonly lotSqft: number | null;
  /** 'vacant' for land-only parcels, 'teardown' for old houses. */
  readonly kind: 'vacant' | 'teardown';
}

export interface LotSamplingResult {
  /** Average assessed value (integer CAD) — sampled or fallback. */
  readonly lotSampleAverage: number;
  /** Number of sampled lots (0 when fallback). */
  readonly lotSampleCount: number;
  /** 'sampled-lots' when enough samples; 'community-average' on fallback. */
  readonly lotPriceSource: 'sampled-lots' | 'community-average';
  /** Sample addresses for transparency (empty on fallback). */
  readonly sampleAddresses: readonly string[];
}

/** Minimum lot size in sqft — excludes remnant strips and slivers. */
const MIN_LOT_SQFT = 1000;

/**
 * Non-residential land-use designations to exclude (multi-unit development
 * parcels skew the residential lot average). Matched as a case-insensitive
 * prefix — e.g. 'MU-1', 'MU-2', 'M-C2', 'M-H1', 'C-COR', 'I-B'.
 */
const EXCLUDED_DESIGNATION_PREFIXES: readonly string[] = [
  'MU-', 'M-C', 'M-H', 'M-X', 'C-', 'I-', 'S-CRI', 'S-SPR', 'DC',
];

/** Default config values (overridable via env). */
export const DEFAULT_LOT_SAMPLING_CONFIG: LotSamplingConfig = {
  cap: 10,
  min: 5,
  ageYears: 30,
};

function parsePositiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `community-lot-sampling: invalid ${name} ${JSON.stringify(raw)} (expected a positive integer)`,
    );
  }
  return n;
}

/** Loads sampling config from env vars. Throws on invalid values. */
export function loadLotSamplingConfig(env: NodeJS.ProcessEnv = process.env): LotSamplingConfig {
  const cap = parsePositiveInt(env['LOT_SAMPLE_CAP'], 'LOT_SAMPLE_CAP', DEFAULT_LOT_SAMPLING_CONFIG.cap);
  const min = parsePositiveInt(env['LOT_SAMPLE_MIN'], 'LOT_SAMPLE_MIN', DEFAULT_LOT_SAMPLING_CONFIG.min);
  const ageYears = parsePositiveInt(
    env['LOT_SAMPLE_AGE_YEARS'],
    'LOT_SAMPLE_AGE_YEARS',
    DEFAULT_LOT_SAMPLING_CONFIG.ageYears,
  );
  if (min > cap) {
    throw new Error(
      `community-lot-sampling: LOT_SAMPLE_MIN (${min}) must not exceed LOT_SAMPLE_CAP (${cap})`,
    );
  }
  return { cap, min, ageYears };
}

/**
 * Returns true if the land-use designation indicates a non-residential parcel
 * that should be excluded from the residential lot sample.
 */
export function isExcludedDesignation(designation: string | null | undefined): boolean {
  if (!designation) return false;
  const upper = designation.trim().toUpperCase();
  return EXCLUDED_DESIGNATION_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Raw Socrata/DB row for a candidate lot. */
export interface RawLotRow {
  readonly address?: string | null;
  readonly assessed_value?: string | number | null;
  readonly land_size_sf?: string | number | null;
  readonly land_use_designation?: string | null;
  readonly year_of_construction?: string | number | null;
  readonly property_type?: string | null;
  readonly assessment_class?: string | null;
}

function toInt(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/**
 * Filters raw rows to qualifying lot samples.
 *
 * A row qualifies if:
 *   - It has a non-empty address and a positive assessed value.
 *   - `land_size_sf` is null (unknown) or >= MIN_LOT_SQFT.
 *   - `land_use_designation` is not in the excluded non-residential list.
 *   - For 'teardown' kind: `year_of_construction <= currentYear - ageYears`.
 *
 * Rows are returned sorted by assessed value ascending (deterministic).
 */
export function filterLotSamples(
  rows: readonly RawLotRow[],
  kind: 'vacant' | 'teardown',
  config: LotSamplingConfig,
  currentYear: number = new Date().getFullYear(),
): LotSample[] {
  const cutoffYear = currentYear - config.ageYears;
  const samples: LotSample[] = [];

  for (const row of rows) {
    const address = (row.address ?? '').trim();
    const assessedValue = toInt(row.assessed_value);
    if (!address || assessedValue === null || assessedValue <= 0) continue;

    const lotSqft = toInt(row.land_size_sf);
    if (lotSqft !== null && lotSqft < MIN_LOT_SQFT) continue;

    if (isExcludedDesignation(row.land_use_designation)) continue;

    if (kind === 'teardown') {
      const yearBuilt = toInt(row.year_of_construction);
      if (yearBuilt === null || yearBuilt > cutoffYear) continue;
    }

    samples.push({ address, assessedValue, lotSqft, kind });
  }

  // Deterministic: sort by assessed value, then address as tiebreaker.
  samples.sort((a, b) => a.assessedValue - b.assessedValue || a.address.localeCompare(b.address));
  return samples;
}

/**
 * Merges vacant and teardown samples into a final result.
 *
 * Priority: vacant lots first (direct land measurement), then teardown
 * proxies, up to `config.cap` total. If the combined count meets
 * `config.min`, returns the sampled average; otherwise falls back to the
 * provided community average with `lotPriceSource: 'community-average'`.
 */
export function mergeLotSamples(
  vacant: readonly LotSample[],
  teardown: readonly LotSample[],
  config: LotSamplingConfig,
  fallbackAverage: number,
): LotSamplingResult {
  // Vacant lots first, then teardown proxies, capped at `cap`.
  const combined = [...vacant, ...teardown].slice(0, config.cap);

  if (combined.length >= config.min) {
    const sum = combined.reduce((acc, s) => acc + s.assessedValue, 0);
    return {
      lotSampleAverage: Math.round(sum / combined.length),
      lotSampleCount: combined.length,
      lotPriceSource: 'sampled-lots',
      sampleAddresses: combined.map((s) => s.address),
    };
  }

  return {
    lotSampleAverage: Math.round(fallbackAverage),
    lotSampleCount: 0,
    lotPriceSource: 'community-average',
    sampleAddresses: [],
  };
}

/**
 * Builds the SoQL WHERE clause fragment for vacant residential lots.
 * Exported for reuse by the build script's Socrata and Postgres paths.
 */
export function vacantLotsWhere(communityName: string): string {
  const escaped = communityName.replace(/'/g, "''");
  return (
    `comm_name='${escaped}'` +
    ` AND property_type='LO'` +
    ` AND assessment_class='RE'` +
    ` AND (land_size_sf IS NULL OR land_size_sf >= ${MIN_LOT_SQFT})`
  );
}

/**
 * Builds the SoQL WHERE clause fragment for teardown-proxy houses.
 * Exported for reuse by the build script's Socrata and Postgres paths.
 */
export function teardownLotsWhere(
  communityName: string,
  ageYears: number,
  currentYear: number = new Date().getFullYear(),
): string {
  const escaped = communityName.replace(/'/g, "''");
  const cutoffYear = currentYear - ageYears;
  return (
    `comm_name='${escaped}'` +
    ` AND property_type='LI'` +
    ` AND assessment_class='RE'` +
    ` AND year_of_construction <= ${cutoffYear}` +
    ` AND (land_size_sf IS NULL OR land_size_sf >= ${MIN_LOT_SQFT})`
  );
}

/**
 * Fetches candidate lot rows from Socrata for one community.
 *
 * Runs two queries (vacant + teardown) and returns the raw rows.
 * The caller filters via `filterLotSamples` (which applies the
 * designation exclusion that can't be expressed cleanly in SoQL).
 */
export async function fetchLotRowsFromSocrata(
  communityName: string,
  config: Pick<LotSamplingConfig, 'cap' | 'ageYears'> & { socrataBaseUrl: string; socrataDataset: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ vacant: RawLotRow[]; teardown: RawLotRow[] }> {
  const fields = 'address,assessed_value,land_size_sf,land_use_designation,year_of_construction,property_type,assessment_class';

  async function query(where: string): Promise<RawLotRow[]> {
    const params = new URLSearchParams({
      $select: fields,
      $where: where,
      $order: 'assessed_value ASC',
      $limit: String(config.cap),
    });
    const url = `${config.socrataBaseUrl}/resource/${config.socrataDataset}.json?${params}`;
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`Socrata lot query failed: HTTP ${res.status} for ${config.socrataDataset}`);
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error('Socrata lot query failed: expected a JSON array');
    return body as RawLotRow[];
  }

  const [vacant, teardown] = await Promise.all([
    query(vacantLotsWhere(communityName)),
    query(teardownLotsWhere(communityName, config.ageYears)),
  ]);
  return { vacant, teardown };
}
