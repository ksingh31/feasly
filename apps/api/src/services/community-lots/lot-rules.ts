/**
 * Community lot inventory — pure rules (#691).
 *
 * Everything here is deterministic and I/O-free so each guard is unit
 * tested on its own:
 * - which assessment rows are vacant residential land-only parcels,
 * - which current districts qualify (low-density / grade-oriented),
 * - the sliver guard,
 * - the diff a refresh applies (insert / update / unchanged / remove),
 * - list filtering, sorting and keyset cursor pagination.
 *
 * No dollar maths: the only money value is the City-assessed value, passed
 * through verbatim (rounded to whole dollars as the City publishes it).
 */
import { z } from 'zod';
import type {
  CommunityLotDistrictSource,
  CommunityLotKind,
  CommunityLotSort,
} from '@feasly/contracts';

/** Assessment-roll codes for a residential land-only parcel. */
export const VACANT_PROPERTY_TYPE = 'LO';
export const RESIDENTIAL_ASSESSMENT_CLASS = 'RE';

/** One stored lot (domain shape; the route serializes it to the contract). */
export interface CommunityLotRecord {
  readonly city: string;
  readonly communitySlug: string;
  readonly rollNumber: string;
  readonly address: string;
  readonly lotSqft: number | null;
  readonly assessedValue: number;
  readonly rollYear: string;
  readonly district: string | null;
  readonly districtSource: CommunityLotDistrictSource;
  readonly kind: CommunityLotKind;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

/** A stored lot plus its bookkeeping timestamps. */
export interface StoredCommunityLot extends CommunityLotRecord {
  readonly firstSeenAt: Date;
  readonly updatedAt: Date;
}

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v : Number(v.trim())))
  .refine((v) => Number.isFinite(v));

/** The assessment columns the refresh reads (Socrata `4bsw-nn7w`). */
export const ParcelRow = z.object({
  roll_number: z.string().trim().min(1),
  address: z.string().trim().min(1),
  roll_year: z.string().trim().min(1),
  assessed_value: numeric,
  land_size_sf: numeric.optional().nullable(),
  land_use_designation: z.string().optional().nullable(),
  property_type: z.string().optional().nullable(),
  assessment_class: z.string().optional().nullable(),
  multipolygon: z.unknown().optional(),
});
export type ParcelRow = z.infer<typeof ParcelRow>;

/** Socrata `$select` for {@link ParcelRow}. */
export const PARCEL_FIELDS = [
  'roll_number',
  'address',
  'roll_year',
  'assessed_value',
  'land_size_sf',
  'land_use_designation',
  'property_type',
  'assessment_class',
  'multipolygon',
] as const;

/** Why a parcel was not listed (counted per run; never logged per address). */
export type ExclusionReason =
  | 'unparseable'
  | 'not-residential-vacant'
  | 'no-assessed-value'
  | 'sliver'
  | 'district-not-allowed';

/** True when `code` starts with one of the allowed prefixes (case-insensitive). */
export function isAllowedDistrict(
  code: string | null | undefined,
  allowedPrefixes: readonly string[],
): boolean {
  if (!code) return false;
  const upper = code.trim().toUpperCase();
  if (!upper) return false;
  return allowedPrefixes.some((prefix) => upper.startsWith(prefix.trim().toUpperCase()));
}

/**
 * Fallback district from the assessment roll's designation, used only when
 * the current map has no polygon at the point (or the city has no map).
 * The roll can carry several codes ("R-C2,R-CG"; pre-repeal pairs), so the
 * parcel qualifies only when EVERY listed code is allowed — a parcel that
 * might be multi-residential or commercial is never listed on a guess.
 */
export function rollDistrict(
  designation: string | null | undefined,
  allowedPrefixes: readonly string[],
): { readonly district: string | null; readonly allowed: boolean } {
  const codes = (designation ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (codes.length === 0) return { district: null, allowed: false };
  return {
    // The last listed code is the post-repeal one in the City's pairs.
    district: codes[codes.length - 1],
    allowed: codes.every((c) => isAllowedDistrict(c, allowedPrefixes)),
  };
}

/** True for a residential land-only parcel (the vacant-lot definition). */
export function isResidentialVacant(row: ParcelRow): boolean {
  return (
    (row.property_type ?? '').trim().toUpperCase() === VACANT_PROPERTY_TYPE &&
    (row.assessment_class ?? '').trim().toUpperCase() === RESIDENTIAL_ASSESSMENT_CLASS
  );
}

/** Lot area in whole square feet, or null when unknown / non-positive. */
export function lotSqftOf(row: ParcelRow): number | null {
  const v = row.land_size_sf;
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v);
}

/**
 * Guards that need no network: residential land-only, positive assessed
 * value, sliver guard. Returns the exclusion reason, or null to continue
 * to the district check. A lot with unknown area is kept (the City lacks
 * the figure; it is not a sliver).
 */
export function preDistrictExclusion(row: ParcelRow, minLotSqft: number): ExclusionReason | null {
  if (!isResidentialVacant(row)) return 'not-residential-vacant';
  if (!(row.assessed_value > 0)) return 'no-assessed-value';
  const sqft = lotSqftOf(row);
  if (minLotSqft > 0 && sqft !== null && sqft < minLotSqft) return 'sliver';
  return null;
}

/** Fields a refresh compares to decide whether a stored lot changed. */
const COMPARED_FIELDS = [
  'communitySlug',
  'address',
  'lotSqft',
  'assessedValue',
  'rollYear',
  'district',
  'districtSource',
  'kind',
  'latitude',
  'longitude',
] as const satisfies readonly (keyof CommunityLotRecord)[];

/** Coordinates are compared at ~1 cm so float noise is not a "change". */
function sameValue(a: unknown, b: unknown, field: string): boolean {
  if ((field === 'latitude' || field === 'longitude') && typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-7;
  }
  return a === b;
}

export function lotChanged(stored: CommunityLotRecord, incoming: CommunityLotRecord): boolean {
  return COMPARED_FIELDS.some((f) => !sameValue(stored[f], incoming[f], f));
}

export interface LotDiff {
  readonly insert: readonly CommunityLotRecord[];
  readonly update: readonly CommunityLotRecord[];
  readonly unchanged: number;
  /** Roll numbers stored for the community but absent from the source. */
  readonly remove: readonly string[];
}

/**
 * What a refresh must write for one community. Re-running with unchanged
 * source data yields no inserts, updates or removals (idempotent).
 */
export function diffLots(
  stored: readonly CommunityLotRecord[],
  incoming: readonly CommunityLotRecord[],
): LotDiff {
  const byRoll = new Map(stored.map((s) => [s.rollNumber, s]));
  const seen = new Set<string>();
  const insert: CommunityLotRecord[] = [];
  const update: CommunityLotRecord[] = [];
  let unchanged = 0;
  for (const lot of incoming) {
    if (seen.has(lot.rollNumber)) continue; // once each
    seen.add(lot.rollNumber);
    const prev = byRoll.get(lot.rollNumber);
    if (!prev) insert.push(lot);
    else if (lotChanged(prev, lot)) update.push(lot);
    else unchanged++;
  }
  const remove = stored.filter((s) => !seen.has(s.rollNumber)).map((s) => s.rollNumber);
  return { insert, update, unchanged, remove };
}

// ── Listing: filters, sort, keyset cursor ──────────────────────────────

export interface LotListFilters {
  readonly kind?: CommunityLotKind;
  /** Exact district code, case-insensitive. */
  readonly district?: string;
  readonly minLotSqft?: number;
  readonly maxLotSqft?: number;
  readonly sort: CommunityLotSort;
  readonly limit: number;
  readonly cursor?: string;
}

export interface LotPage<T extends CommunityLotRecord> {
  readonly total: number;
  readonly lots: readonly T[];
  readonly nextCursor: string | null;
}

/** Thrown for a cursor that does not decode or does not match the sort. */
export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

interface CursorPayload {
  readonly s: CommunityLotSort;
  /** Sort key of the last row on the previous page. */
  readonly k: string | number | null;
  /** Roll number of that row (tiebreaker). */
  readonly r: string;
}

const CursorSchema = z.object({
  s: z.enum(['address', 'lot-size-asc', 'lot-size-desc']),
  k: z.union([z.string(), z.number(), z.null()]),
  r: z.string().min(1),
});

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, sort: CommunityLotSort): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const result = CursorSchema.safeParse(parsed);
  if (!result.success || result.data.s !== sort) throw new InvalidCursorError();
  return result.data;
}

/** Sort key; lots with unknown area sort last in both directions. */
function sortKey(lot: CommunityLotRecord, sort: CommunityLotSort): string | number | null {
  return sort === 'address' ? lot.address : lot.lotSqft;
}

function compareKeys(
  a: string | number | null,
  b: string | number | null,
  sort: CommunityLotSort,
): number {
  if (a === b) return 0;
  if (a === null) return 1; // nulls last
  if (b === null) return -1;
  if (sort === 'address') return String(a) < String(b) ? -1 : 1;
  const diff = Number(a) - Number(b);
  return sort === 'lot-size-desc' ? -diff : diff;
}

function compareLots(a: CommunityLotRecord, b: CommunityLotRecord, sort: CommunityLotSort): number {
  const byKey = compareKeys(sortKey(a, sort), sortKey(b, sort), sort);
  if (byKey !== 0) return byKey;
  return a.rollNumber < b.rollNumber ? -1 : a.rollNumber > b.rollNumber ? 1 : 0;
}

function matches(lot: CommunityLotRecord, f: LotListFilters): boolean {
  if (f.kind && lot.kind !== f.kind) return false;
  if (f.district && (lot.district ?? '').toUpperCase() !== f.district.trim().toUpperCase()) {
    return false;
  }
  if (f.minLotSqft !== undefined && (lot.lotSqft === null || lot.lotSqft < f.minLotSqft)) {
    return false;
  }
  if (f.maxLotSqft !== undefined && (lot.lotSqft === null || lot.lotSqft > f.maxLotSqft)) {
    return false;
  }
  return true;
}

/**
 * Filter, sort and page a community's lots. Deterministic total order
 * (sort key, then roll number), so a keyset cursor never skips or repeats
 * a row between pages.
 */
export function pageLots<T extends CommunityLotRecord>(
  lots: readonly T[],
  filters: LotListFilters,
): LotPage<T> {
  const { sort, limit } = filters;
  const filtered = lots.filter((l) => matches(l, filters)).sort((a, b) => compareLots(a, b, sort));
  let start = 0;
  if (filters.cursor) {
    const c = decodeCursor(filters.cursor, sort);
    // First row strictly after the cursor's (key, roll number).
    start = filtered.findIndex((l) => {
      const byKey = compareKeys(sortKey(l, sort), c.k, sort);
      return byKey > 0 || (byKey === 0 && l.rollNumber > c.r);
    });
    if (start === -1) start = filtered.length;
  }
  const page = filtered.slice(start, start + limit);
  const last = page[page.length - 1];
  const hasMore = start + limit < filtered.length;
  return {
    total: filtered.length,
    lots: page,
    nextCursor:
      hasMore && last ? encodeCursor({ s: sort, k: sortKey(last, sort), r: last.rollNumber }) : null,
  };
}
