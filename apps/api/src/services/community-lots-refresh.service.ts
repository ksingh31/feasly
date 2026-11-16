/**
 * Community lot inventory refresh (#691, phase 1).
 *
 * Derives the vacant residential lots in established infill communities
 * from City open data and stores them for the community guide:
 *
 * 1. Latest assessment roll year + the established communities (boundary
 *    `class` + `comm_structure` from config — owner decision 2026-11-15:
 *    infill only, same rule as #690; greenfield suburbs are excluded).
 * 2. Per community: page through the residential land-only parcels
 *    (`property_type='LO' AND assessment_class='RE'`), apply the sliver
 *    guard, resolve each parcel's CURRENT district from the Land Use
 *    Districts map (bounded concurrency, retried), keep low-density /
 *    grade-oriented districts only.
 * 3. Diff against the stored lots and write the community in one
 *    transaction: new lots inserted, changed lots updated, vanished lots
 *    removed, unchanged lots untouched (idempotent).
 *
 * Failure semantics (AC4): a community whose fetch fails keeps its stored
 * lots and is reported failed; the run continues with the next community
 * (resumable per community). A failure to list communities or the roll
 * year aborts before anything is written. A run with any failure is
 * reported `failed`; `alertAfterConsecutiveFailures` failed runs in a row
 * fire the `community_lots_failed` ops alert, and a clean run clears it.
 *
 * No dollar maths: the City-assessed value is passed through verbatim.
 * Nothing per-address is logged — counts only.
 *
 * DB access lives in `CommunityLotsStore`; this service never imports
 * src/db/ (test/boundaries.test.ts).
 */
import type { CommunityLotsConfig } from '../config';
import { parcelInteriorPoint } from '../lib/geo';
import { toSlug } from './community-stats/socrata-aggregates';
import type { LandUseProvider } from './land-use.service';
import type { CommunityLotsStore } from './community-lots.store';
import {
  PARCEL_FIELDS,
  ParcelRow,
  RESIDENTIAL_ASSESSMENT_CLASS,
  VACANT_PROPERTY_TYPE,
  diffLots,
  isAllowedDistrict,
  lotSqftOf,
  preDistrictExclusion,
  rollDistrict,
  type CommunityLotRecord,
  type ExclusionReason,
} from './community-lots/lot-rules';

/** An established infill community from the boundaries dataset. */
export interface EstablishedCommunity {
  readonly name: string;
  /** City community code, e.g. 'ALT' — the assessment rows' `comm_code`. */
  readonly code: string;
  readonly slug: string;
}

/** Source of City data. Socrata in production; faked in tests. */
export interface CommunityLotsSource {
  latestRollYear(): Promise<string>;
  establishedCommunities(): Promise<EstablishedCommunity[]>;
  /** Raw residential land-only parcel rows for one community (all pages). */
  vacantParcels(rollYear: string, communityCode: string): Promise<unknown[]>;
}

export type CommunityLotsSourceConfig = Pick<
  CommunityLotsConfig,
  | 'socrataBaseUrl'
  | 'assessmentDatasetId'
  | 'boundariesDatasetId'
  | 'establishedClasses'
  | 'establishedStructures'
  | 'pageSize'
  | 'requestDelayMs'
  | 'httpTimeoutMs'
  | 'maxAttempts'
>;

/** SoQL string literal: single quotes doubled. Values come from config / the City. */
function soqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const COMMUNITY_CODE_RE = /^[A-Z0-9]{1,10}$/;
const ROLL_YEAR_RE = /^\d{4}$/;

/** Retry with exponential backoff; rethrows the last error. */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  sleep: (ms: number) => Promise<void>,
  baseDelayMs = 500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Live Socrata source. Pages with a stable `$order`, pauses
 * `requestDelayMs` between requests and retries each request; any request
 * that still fails throws (the service reports the community failed).
 */
export function createSocrataCommunityLotsSource(
  config: CommunityLotsSourceConfig,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): CommunityLotsSource {
  const userAgent = 'feasly-community-lots-refresh/1.0';

  async function fetchJsonOnce(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': userAgent, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Socrata request failed: ${res.status}`);
      return (await res.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchRows(dataset: string, params: Record<string, string>): Promise<unknown[]> {
    const url = `${config.socrataBaseUrl}/resource/${dataset}.json?${new URLSearchParams(params).toString()}`;
    const body = await withRetry(() => fetchJsonOnce(url), config.maxAttempts, sleep);
    if (!Array.isArray(body)) throw new Error('Socrata response was not an array');
    return body as unknown[];
  }

  return {
    async latestRollYear() {
      const rows = await fetchRows(config.assessmentDatasetId, {
        $select: 'roll_year',
        $order: 'roll_year DESC',
        $limit: '1',
      });
      const year = (rows[0] as { roll_year?: unknown } | undefined)?.roll_year;
      if (typeof year !== 'string' || !ROLL_YEAR_RE.test(year)) {
        throw new Error('could not determine latest roll_year');
      }
      return year;
    },

    async establishedCommunities() {
      const rows = await fetchRows(config.boundariesDatasetId, {
        $select: 'name,comm_code',
        $where:
          `class in(${config.establishedClasses.map(soqlString).join(',')})` +
          ` AND comm_structure in(${config.establishedStructures.map(soqlString).join(',')})`,
        $order: 'comm_code',
        $limit: '5000',
      });
      const out: EstablishedCommunity[] = [];
      for (const raw of rows) {
        const r = raw as { name?: unknown; comm_code?: unknown };
        const name = typeof r.name === 'string' ? r.name.trim() : '';
        const code = typeof r.comm_code === 'string' ? r.comm_code.trim().toUpperCase() : '';
        const slug = toSlug(name);
        if (!name || !slug || !COMMUNITY_CODE_RE.test(code)) continue;
        out.push({ name, code, slug });
      }
      return out;
    },

    async vacantParcels(rollYear, communityCode) {
      if (!ROLL_YEAR_RE.test(rollYear) || !COMMUNITY_CODE_RE.test(communityCode)) {
        throw new Error('invalid roll year or community code');
      }
      const all: unknown[] = [];
      for (let offset = 0; ; offset += config.pageSize) {
        if (offset > 0) await sleep(config.requestDelayMs);
        const page = await fetchRows(config.assessmentDatasetId, {
          $select: PARCEL_FIELDS.join(','),
          $where:
            `roll_year=${soqlString(rollYear)} AND comm_code=${soqlString(communityCode)}` +
            ` AND property_type=${soqlString(VACANT_PROPERTY_TYPE)}` +
            ` AND assessment_class=${soqlString(RESIDENTIAL_ASSESSMENT_CLASS)}`,
          $order: 'roll_number',
          $limit: String(config.pageSize),
          $offset: String(offset),
        });
        all.push(...page);
        if (page.length < config.pageSize) return all;
      }
    },
  };
}

export interface CommunityLotsRefreshResult {
  readonly status: 'ok' | 'failed';
  readonly rollYear: string;
  readonly communities: number;
  readonly failedCommunities: number;
  readonly listed: number;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly removed: number;
  /** Communities dropped from the inventory (no longer established). */
  readonly communitiesRemoved: number;
  readonly excluded: Readonly<Record<ExclusionReason, number>>;
  readonly refreshedAt: Date;
  readonly durationMs: number;
  readonly consecutiveFailures: number;
}

export interface CommunityLotsRefreshServiceDeps {
  readonly store: CommunityLotsStore;
  readonly source: CommunityLotsSource;
  /** Current-district provider; undefined → assessment-roll designation only. */
  readonly landUse?: LandUseProvider;
  readonly config: Pick<
    CommunityLotsConfig,
    | 'city'
    | 'minLotSqft'
    | 'allowedDistrictPrefixes'
    | 'districtConcurrency'
    | 'maxAttempts'
    | 'requestDelayMs'
    | 'alertAfterConsecutiveFailures'
  >;
  readonly onRefreshFailing?: (args: {
    readonly consecutiveFailures: number;
    readonly firstFailureAt: Date;
  }) => Promise<void>;
  /** Called after every clean run; the ops-alert service no-ops unless an alert fired. */
  readonly onRefreshRecovered?: () => Promise<void>;
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logWarning?: (message: string) => void;
}

export interface CommunityLotsRefreshService {
  /**
   * Run one refresh. Returns `status: 'failed'` when any community failed
   * (its stored lots are kept); throws only when nothing could be fetched
   * (roll year / community list), before any write.
   */
  runRefreshCycle(): Promise<CommunityLotsRefreshResult>;
}

/** Map with at most `limit` promises in flight; order preserved. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function emptyExclusions(): Record<ExclusionReason, number> {
  return {
    unparseable: 0,
    'not-residential-vacant': 0,
    'no-assessed-value': 0,
    sliver: 0,
    'district-not-allowed': 0,
  };
}

export function createCommunityLotsRefreshService(
  deps: CommunityLotsRefreshServiceDeps,
): CommunityLotsRefreshService {
  const {
    store,
    source,
    landUse,
    config,
    onRefreshFailing,
    onRefreshRecovered,
    clock = () => new Date(),
    sleep = defaultSleep,
    logWarning = (message: string) => console.warn(message),
  } = deps;

  let consecutiveFailures = 0;
  let firstFailureAt: Date | null = null;

  /** Qualifying lot for one parsed parcel, or the reason it is excluded. */
  async function toLot(
    row: ParcelRow,
    community: EstablishedCommunity,
  ): Promise<CommunityLotRecord | ExclusionReason> {
    const pre = preDistrictExclusion(row, config.minLotSqft);
    if (pre) return pre;
    const point = parcelInteriorPoint(row.multipolygon);
    let district: string | null = null;
    let districtSource: CommunityLotRecord['districtSource'] = 'assessment-roll';
    let allowed = false;
    const resolved =
      landUse && point
        ? await withRetry(() => landUse.resolve(point), config.maxAttempts, sleep)
        : null;
    if (resolved) {
      district = resolved.district;
      districtSource = 'land-use-districts';
      allowed = isAllowedDistrict(district, config.allowedDistrictPrefixes);
    } else {
      const fallback = rollDistrict(row.land_use_designation, config.allowedDistrictPrefixes);
      district = fallback.district;
      allowed = fallback.allowed;
    }
    if (!allowed) return 'district-not-allowed';
    return {
      city: config.city,
      communitySlug: community.slug,
      rollNumber: row.roll_number,
      address: row.address,
      lotSqft: lotSqftOf(row),
      assessedValue: Math.round(row.assessed_value),
      rollYear: row.roll_year,
      district,
      districtSource,
      kind: 'vacant',
      latitude: point ? point.lat : null,
      longitude: point ? point.lon : null,
    };
  }

  async function recordFailure(): Promise<void> {
    if (consecutiveFailures === 0) firstFailureAt = clock();
    consecutiveFailures++;
    if (consecutiveFailures >= config.alertAfterConsecutiveFailures) {
      // Ops-alert service dedupes (one email per 24h per class).
      await onRefreshFailing?.({
        consecutiveFailures,
        firstFailureAt: firstFailureAt ?? clock(),
      });
    }
  }

  return {
    async runRefreshCycle(): Promise<CommunityLotsRefreshResult> {
      const started = clock();
      let rollYear: string;
      let communities: EstablishedCommunity[];
      try {
        rollYear = await source.latestRollYear();
        communities = await source.establishedCommunities();
        if (communities.length === 0) {
          throw new Error('no established communities returned — refusing to prune');
        }
      } catch (error) {
        await recordFailure();
        throw error;
      }

      // Deduplicate by slug (a boundary listed twice is one community).
      const bySlug = new Map<string, EstablishedCommunity>();
      for (const c of communities) if (!bySlug.has(c.slug)) bySlug.set(c.slug, c);
      const ordered = [...bySlug.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));

      const excluded = emptyExclusions();
      let listed = 0;
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      let removed = 0;
      let failedCommunities = 0;

      for (const community of ordered) {
        try {
          const rawRows = await source.vacantParcels(rollYear, community.code);
          const parsed: ParcelRow[] = [];
          for (const raw of rawRows) {
            const r = ParcelRow.safeParse(raw);
            if (r.success) parsed.push(r.data);
            else excluded.unparseable++;
          }
          const results = await mapBounded(parsed, config.districtConcurrency, (row) =>
            toLot(row, community),
          );
          const lots: CommunityLotRecord[] = [];
          const local = emptyExclusions();
          for (const r of results) {
            if (typeof r === 'string') local[r]++;
            else lots.push(r);
          }
          const stored = await store.listLots(config.city, community.slug);
          const diff = diffLots(stored, lots);
          const lotCount = diff.insert.length + diff.update.length + diff.unchanged;
          await store.applyCommunity({
            city: config.city,
            communitySlug: community.slug,
            communityName: community.name,
            rollYear,
            refreshedAt: clock(),
            diff,
            lotCount,
          });
          for (const k of Object.keys(local) as ExclusionReason[]) excluded[k] += local[k];
          listed += lotCount;
          inserted += diff.insert.length;
          updated += diff.update.length;
          unchanged += diff.unchanged;
          removed += diff.remove.length;
        } catch (error) {
          failedCommunities++;
          // Community name only (public), never addresses.
          logWarning(
            `community-lots-refresh: ${community.slug} failed, stored lots kept ` +
              `(${error instanceof Error ? error.message : String(error)})`,
          );
        }
        if (config.requestDelayMs > 0) await sleep(config.requestDelayMs);
      }

      const communitiesRemoved = await store.removeCommunitiesExcept(config.city, [
        ...bySlug.keys(),
      ]);

      const status = failedCommunities > 0 ? 'failed' : 'ok';
      if (status === 'failed') {
        await recordFailure();
      } else {
        consecutiveFailures = 0;
        firstFailureAt = null;
        await onRefreshRecovered?.();
      }
      const finished = clock();
      return {
        status,
        rollYear,
        communities: ordered.length,
        failedCommunities,
        listed,
        inserted,
        updated,
        unchanged,
        removed,
        communitiesRemoved,
        excluded,
        refreshedAt: finished,
        durationMs: finished.getTime() - started.getTime(),
        consecutiveFailures,
      };
    },
  };
}
