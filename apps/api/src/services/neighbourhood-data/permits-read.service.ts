/**
 * Nearby permits reads (#822) — the request-path side.
 *
 * Serves ONLY from the `permits` table (filled by the monthly neighbourhood
 * refresh, provider 'permits') and the shared property roll cache (#756) for
 * the address's location. It has no provider dependency, so a page view
 * never triggers a City permits call (test/permits.read.test.ts).
 *
 * Computed summaries are reused from the shared City-data cache, keyed by
 * the refresh they were computed from: a new monthly load is a cache miss.
 *
 * Definitions (documented in docs/ops/neighbourhood-data.md):
 * - "new homes" = housing units on residential new-build BPs issued in the
 *   window (a BP without a unit count counts as one).
 * - DP-to-BP = DP application → BP issue at the same address, linking a BP
 *   to the latest DP applied for at most `dpBpMaxGapDays` before it.
 * - Medians need `minSample` values, else null. Weeks are rounded.
 */
import { haversineMeters } from '../../lib/geo';
import type { CityDataCacheStore } from '../city-data-cache.store';
import type { PropertyLocator } from '../property.service';
import type { NeighbourhoodDataStore, StoredPermit } from './neighbourhood-data.store';
import { boundingBox } from './neighbourhood-read.service';

export interface NearbyPermit {
  readonly kind: 'building' | 'development';
  readonly permitNumber: string;
  readonly address: string | null;
  readonly permitType: string | null;
  readonly status: string | null;
  readonly year: number | null;
  readonly builder: string | null;
  readonly distanceM: number;
  readonly recordUrl: string;
}

export interface NearbyPermits {
  readonly addressKey: string;
  readonly radiusM: number;
  readonly sinceYear: number;
  readonly buildingPermits: number;
  readonly newHomes: number;
  readonly developmentPermits: number;
  readonly typicalDpToBpWeeks: number | null;
  readonly total: number;
  readonly permits: readonly NearbyPermit[];
  readonly dataRefreshedAt: string;
}

export interface CommunityPermitYear {
  readonly year: number;
  readonly buildingPermits: number;
  readonly newHomes: number;
  readonly developmentPermits: number;
}

export interface CommunityPermits {
  readonly communityCode: string;
  readonly name: string;
  readonly slug: string;
  readonly perYear: readonly CommunityPermitYear[];
  readonly sinceYear: number;
  readonly medianApprovalWeeks: {
    readonly buildingPermit: number | null;
    readonly developmentPermit: number | null;
    readonly dpToBp: number | null;
  };
  readonly dataRefreshedAt: string;
}

/** Why a summary is unavailable. */
export type PermitsUnavailable = 'not-loaded' | 'no-location' | 'unknown-community';

export type PermitsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: PermitsUnavailable };

export interface PermitsReadServiceDeps {
  readonly store: Pick<NeighbourhoodDataStore, 'permitsIn' | 'communityPermits' | 'getState'>;
  /** Address → parcel point through the shared roll cache (#756). */
  readonly locator: PropertyLocator;
  readonly radiusM: number;
  readonly lookbackYears: number;
  readonly historyYears: number;
  readonly listLimit: number;
  readonly minSample: number;
  readonly dpBpMaxGapDays: number;
  /** Contains `{permitNumber}`. */
  readonly recordUrlTemplate: string;
  readonly cache?: Pick<CityDataCacheStore, 'get' | 'put'>;
  readonly summaryTtlMs: number;
  readonly clock?: () => Date;
  readonly logWarning?: (message: string) => void;
}

export interface PermitsReadService {
  getNearbyPermits(addressKey: string): Promise<PermitsResult<NearbyPermits>>;
  /** By City community code ('ALT') or slug ('altadore'). */
  getCommunityPermits(codeOrSlug: string): Promise<PermitsResult<CommunityPermits>>;
}

/** Shared-cache dataset ids (#756 table). */
export const PERMITS_NEARBY_CACHE_DATASET = 'neighbourhood-permits-nearby';
export const PERMITS_COMMUNITY_CACHE_DATASET = 'neighbourhood-permits-community';

const DAY_MS = 86_400_000;

function dayNumber(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / DAY_MS) : null;
}

function yearOf(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const y = Number(isoDate.slice(0, 4));
  return Number.isInteger(y) ? y : null;
}

/** Median in whole weeks of day spans; null below `minSample`. */
export function medianWeeks(days: readonly number[], minSample: number): number | null {
  const values = days.filter((d) => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
  if (values.length === 0 || values.length < minSample) return null;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
  return Math.round(median / 7);
}

function normalizeAddress(address: string | null): string | null {
  const a = address?.toUpperCase().replace(/\s+/g, ' ').trim();
  return a ? a : null;
}

/**
 * DP application → BP issue spans (days) for the given BPs, each linked to
 * the latest DP at the same address applied for no more than `maxGapDays`
 * before the BP application.
 */
export function dpToBpDays(
  bps: readonly StoredPermit[],
  dps: readonly StoredPermit[],
  maxGapDays: number,
): number[] {
  const dpDaysByAddress = new Map<string, number[]>();
  for (const dp of dps) {
    const address = normalizeAddress(dp.address);
    const applied = dayNumber(dp.appliedOn);
    if (!address || applied === null) continue;
    const list = dpDaysByAddress.get(address) ?? [];
    list.push(applied);
    dpDaysByAddress.set(address, list);
  }
  const out: number[] = [];
  for (const bp of bps) {
    const address = normalizeAddress(bp.address);
    const bpApplied = dayNumber(bp.appliedOn);
    const bpIssued = dayNumber(bp.decidedOn);
    if (!address || bpApplied === null || bpIssued === null) continue;
    const candidates = (dpDaysByAddress.get(address) ?? []).filter(
      (d) => d <= bpApplied && bpApplied - d <= maxGapDays,
    );
    if (candidates.length === 0) continue;
    out.push(bpIssued - Math.max(...candidates));
  }
  return out;
}

function spanDays(p: StoredPermit): number | null {
  const a = dayNumber(p.appliedOn);
  const d = dayNumber(p.decidedOn);
  return a !== null && d !== null ? d - a : null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export function createPermitsReadService(deps: PermitsReadServiceDeps): PermitsReadService {
  const {
    store,
    locator,
    radiusM,
    lookbackYears,
    historyYears,
    listLimit,
    minSample,
    dpBpMaxGapDays,
    recordUrlTemplate,
    cache,
    summaryTtlMs,
    clock = () => new Date(),
    logWarning = (message: string) => console.warn(message),
  } = deps;

  const recordUrl = (permitNumber: string): string =>
    recordUrlTemplate.replace('{permitNumber}', encodeURIComponent(permitNumber));

  /** As-of of the last successful permits load; null when never loaded. */
  async function refreshedAt(): Promise<Date | null> {
    const state = await store.getState('permits');
    return state?.lastSuccessAt ?? null;
  }

  async function cached<T>(
    dataset: string,
    key: string,
    now: Date,
    compute: () => Promise<PermitsResult<T>>,
  ): Promise<PermitsResult<T>> {
    if (cache) {
      try {
        const hit = await cache.get(dataset, key, now);
        if (hit) return { ok: true, value: hit as T };
      } catch (error) {
        logWarning(`permits-read: cache read failed (${errorName(error)})`);
      }
    }
    const result = await compute();
    if (cache && result.ok) {
      try {
        await cache.put(dataset, key, result.value, new Date(now.getTime() + summaryTtlMs));
      } catch (error) {
        logWarning(`permits-read: cache write failed (${errorName(error)})`);
      }
    }
    return result;
  }

  return {
    async getNearbyPermits(addressKey): Promise<PermitsResult<NearbyPermits>> {
      const key = addressKey.trim();
      const asOf = await refreshedAt();
      if (!asOf) return { ok: false, reason: 'not-loaded' };
      const now = clock();
      return cached(PERMITS_NEARBY_CACHE_DATASET, `${asOf.getTime()}:${key}`, now, async () => {
        const point = await locator.getPropertyPoint(key);
        if (!point) return { ok: false, reason: 'no-location' };
        const origin = { lat: point.lat, lon: point.lon };
        const sinceYear = now.getUTCFullYear() - lookbackYears;
        const since = `${sinceYear}-01-01`;
        const nearby = (await store.permitsIn(boundingBox(point.lat, point.lon, radiusM)))
          .filter((p) => p.lat !== null && p.lng !== null)
          .map((p) => ({ p, distanceM: Math.round(haversineMeters(origin, { lat: p.lat!, lon: p.lng! })) }))
          .filter((x) => x.distanceM <= radiusM);

        const bps = nearby.filter((x) => x.p.kind === 'building').map((x) => x.p);
        const dps = nearby.filter((x) => x.p.kind === 'development').map((x) => x.p);
        const issued = bps.filter((p) => p.decidedOn !== null && p.decidedOn >= since);
        const dpsInWindow = dps.filter((p) => p.appliedOn !== null && p.appliedOn >= since);

        const inWindow = nearby
          .map((x) => ({ ...x, date: x.p.decidedOn ?? x.p.appliedOn }))
          .filter((x) => x.date !== null && x.date >= since)
          .sort(
            (a, b) =>
              (b.date! < a.date! ? -1 : b.date! > a.date! ? 1 : 0) ||
              a.p.permitNumber.localeCompare(b.p.permitNumber),
          );

        return {
          ok: true,
          value: {
            addressKey: key,
            radiusM,
            sinceYear,
            buildingPermits: issued.length,
            newHomes: issued.reduce((sum, p) => sum + (p.housingUnits ?? 1), 0),
            developmentPermits: dpsInWindow.length,
            typicalDpToBpWeeks: medianWeeks(dpToBpDays(issued, dps, dpBpMaxGapDays), minSample),
            total: inWindow.length,
            permits: inWindow.slice(0, listLimit).map(({ p, distanceM, date }) => ({
              kind: p.kind,
              permitNumber: p.permitNumber,
              address: p.address,
              permitType: p.permitType,
              status: p.status,
              year: yearOf(date),
              builder: p.builder,
              distanceM,
              recordUrl: recordUrl(p.permitNumber),
            })),
            dataRefreshedAt: asOf.toISOString(),
          },
        };
      });
    },

    async getCommunityPermits(codeOrSlug): Promise<PermitsResult<CommunityPermits>> {
      const key = codeOrSlug.trim().toLowerCase();
      const asOf = await refreshedAt();
      if (!asOf) return { ok: false, reason: 'not-loaded' };
      const now = clock();
      return cached(PERMITS_COMMUNITY_CACHE_DATASET, `${asOf.getTime()}:${key}`, now, async () => {
        const rows = await store.communityPermits(key);
        const first = rows[0];
        const data = (first?.data ?? null) as { communityName?: unknown; slug?: unknown } | null;
        if (
          !first?.communityCode ||
          typeof data?.communityName !== 'string' ||
          typeof data.slug !== 'string'
        ) {
          return { ok: false, reason: 'unknown-community' };
        }
        const currentYear = now.getUTCFullYear();
        const firstYear = currentYear - historyYears;
        const sinceYear = currentYear - lookbackYears;
        const since = `${sinceYear}-01-01`;

        const years = new Map<number, { buildingPermits: number; newHomes: number; developmentPermits: number }>();
        for (let y = firstYear; y <= currentYear; y++) {
          years.set(y, { buildingPermits: 0, newHomes: 0, developmentPermits: 0 });
        }
        for (const p of rows) {
          const bucket = years.get(yearOf(p.decidedOn) ?? -1);
          if (!bucket) continue;
          if (p.kind === 'building') {
            bucket.buildingPermits++;
            bucket.newHomes += p.housingUnits ?? 1;
          } else {
            bucket.developmentPermits++;
          }
        }

        const recent = rows.filter((p) => p.decidedOn !== null && p.decidedOn >= since);
        const recentBps = recent.filter((p) => p.kind === 'building');
        const recentDps = recent.filter((p) => p.kind === 'development');
        const allDps = rows.filter((p) => p.kind === 'development');
        const spans = (list: readonly StoredPermit[]): number[] =>
          list.map(spanDays).filter((d): d is number => d !== null);

        return {
          ok: true,
          value: {
            communityCode: first.communityCode,
            name: data.communityName,
            slug: data.slug,
            perYear: [...years.entries()].map(([year, v]) => ({ year, ...v })),
            sinceYear,
            medianApprovalWeeks: {
              buildingPermit: medianWeeks(spans(recentBps), minSample),
              developmentPermit: medianWeeks(spans(recentDps), minSample),
              dpToBp: medianWeeks(dpToBpDays(recentBps, allDps, dpBpMaxGapDays), minSample),
            },
            dataRefreshedAt: asOf.toISOString(),
          },
        };
      });
    },
  };
}
