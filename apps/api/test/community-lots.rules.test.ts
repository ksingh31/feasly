/**
 * Community lot inventory — pure rules (#691). One test per guard (AC2),
 * the refresh diff (AC3 idempotency) and list paging (AC5).
 */
import { describe, expect, it } from 'vitest';
import {
  InvalidCursorError,
  ParcelRow,
  decodeCursor,
  diffLots,
  encodeCursor,
  isAllowedDistrict,
  pageLots,
  preDistrictExclusion,
  rollDistrict,
  type CommunityLotRecord,
} from '../src/services/community-lots/lot-rules';

const ALLOWED = ['R-', 'H-GO'];

function row(over: Record<string, unknown> = {}): ParcelRow {
  return ParcelRow.parse({
    roll_number: '088034608',
    address: '2032 42 AV SW',
    roll_year: '2026',
    assessed_value: '840500.0',
    land_size_sf: '6134.0',
    land_use_designation: 'R-C2,R-CG',
    property_type: 'LO',
    assessment_class: 'RE',
    ...over,
  });
}

function lot(over: Partial<CommunityLotRecord> = {}): CommunityLotRecord {
  return {
    city: 'calgary',
    communitySlug: 'altadore',
    rollNumber: '1',
    address: '1 A ST SW',
    lotSqft: 5000,
    assessedValue: 800_000,
    rollYear: '2026',
    district: 'R-CG',
    districtSource: 'land-use-districts',
    kind: 'vacant',
    latitude: 51.01,
    longitude: -114.1,
    ...over,
  };
}

describe('guards (AC2)', () => {
  it('keeps a residential land-only parcel above the sliver threshold', () => {
    expect(preDistrictExclusion(row(), 1000)).toBeNull();
  });

  it('excludes slivers below the configured minimum lot area', () => {
    expect(preDistrictExclusion(row({ land_size_sf: '450' }), 1000)).toBe('sliver');
    // 0 disables the guard
    expect(preDistrictExclusion(row({ land_size_sf: '450' }), 0)).toBeNull();
    // unknown area is not a sliver
    expect(preDistrictExclusion(row({ land_size_sf: null }), 1000)).toBeNull();
  });

  it('excludes non-residential parcels (assessment class) and built parcels', () => {
    expect(preDistrictExclusion(row({ assessment_class: 'NR' }), 1000)).toBe(
      'not-residential-vacant',
    );
    expect(preDistrictExclusion(row({ property_type: 'LI' }), 1000)).toBe(
      'not-residential-vacant',
    );
  });

  it('excludes parcels with no positive assessed value', () => {
    expect(preDistrictExclusion(row({ assessed_value: '0' }), 1000)).toBe('no-assessed-value');
  });

  it('allows low-density and grade-oriented districts only', () => {
    for (const d of ['R-CG', 'R-C1', 'r-c2', 'H-GO']) expect(isAllowedDistrict(d, ALLOWED)).toBe(true);
    // multi-residential, mixed-use, commercial, direct control, special purpose
    for (const d of ['M-CG', 'M-C1', 'M-H1', 'MU-1', 'C-COR1', 'DC', 'S-FUD', '', null]) {
      expect(isAllowedDistrict(d, ALLOWED)).toBe(false);
    }
  });

  it('roll-designation fallback requires every listed code to be allowed', () => {
    expect(rollDistrict('R-C2,R-CG', ALLOWED)).toEqual({ district: 'R-CG', allowed: true });
    expect(rollDistrict('M-C2,MU-1', ALLOWED).allowed).toBe(false);
    expect(rollDistrict('M-CG,R-C2,R-CG', ALLOWED).allowed).toBe(false);
    expect(rollDistrict('', ALLOWED)).toEqual({ district: null, allowed: false });
  });

  it('rejects rows missing required columns', () => {
    expect(ParcelRow.safeParse({ address: 'x' }).success).toBe(false);
    expect(ParcelRow.safeParse({ ...row(), assessed_value: 'abc' }).success).toBe(false);
  });
});

describe('diffLots (AC3)', () => {
  it('inserts new, updates changed, removes vanished, counts unchanged', () => {
    const stored = [lot({ rollNumber: '1' }), lot({ rollNumber: '2' }), lot({ rollNumber: '3' })];
    const incoming = [
      lot({ rollNumber: '1' }),
      lot({ rollNumber: '2', assessedValue: 900_000 }),
      lot({ rollNumber: '4' }),
    ];
    const d = diffLots(stored, incoming);
    expect(d.insert.map((l) => l.rollNumber)).toEqual(['4']);
    expect(d.update.map((l) => l.rollNumber)).toEqual(['2']);
    expect(d.unchanged).toBe(1);
    expect(d.remove).toEqual(['3']);
  });

  it('is a no-op on unchanged data (float noise in coordinates ignored)', () => {
    const stored = [lot({ rollNumber: '1', latitude: 51.0100000001 })];
    const d = diffLots(stored, [lot({ rollNumber: '1' })]);
    expect(d).toEqual({ insert: [], update: [], unchanged: 1, remove: [] });
  });

  it('lists a parcel once even when the source repeats it', () => {
    const d = diffLots([], [lot({ rollNumber: '1' }), lot({ rollNumber: '1' })]);
    expect(d.insert).toHaveLength(1);
  });
});

describe('pageLots (AC5)', () => {
  const lots = [
    lot({ rollNumber: 'a', address: '3 C ST', lotSqft: 3000, district: 'R-CG' }),
    lot({ rollNumber: 'b', address: '1 A ST', lotSqft: 7000, district: 'R-C1' }),
    lot({ rollNumber: 'c', address: '2 B ST', lotSqft: null, district: 'H-GO' }),
    lot({ rollNumber: 'd', address: '4 D ST', lotSqft: 7000, district: 'R-CG' }),
  ];

  it('sorts by address by default and pages with a cursor without gaps or repeats', () => {
    const p1 = pageLots(lots, { sort: 'address', limit: 3 });
    expect(p1.total).toBe(4);
    expect(p1.lots.map((l) => l.rollNumber)).toEqual(['b', 'c', 'a']);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = pageLots(lots, { sort: 'address', limit: 3, cursor: p1.nextCursor! });
    expect(p2.lots.map((l) => l.rollNumber)).toEqual(['d']);
    expect(p2.nextCursor).toBeNull();
  });

  it('sorts by lot size (unknown area last) with a roll-number tiebreak', () => {
    expect(pageLots(lots, { sort: 'lot-size-desc', limit: 10 }).lots.map((l) => l.rollNumber)).toEqual(
      ['b', 'd', 'a', 'c'],
    );
    expect(pageLots(lots, { sort: 'lot-size-asc', limit: 10 }).lots.map((l) => l.rollNumber)).toEqual(
      ['a', 'b', 'd', 'c'],
    );
    // walk the desc order one at a time — ties at 7000 must not repeat or skip
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const p = pageLots(lots, { sort: 'lot-size-desc', limit: 1, cursor });
      seen.push(...p.lots.map((l) => l.rollNumber));
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    expect(seen).toEqual(['b', 'd', 'a', 'c']);
  });

  it('filters by district, kind and lot-area range', () => {
    expect(pageLots(lots, { sort: 'address', limit: 10, district: 'r-cg' }).total).toBe(2);
    expect(pageLots(lots, { sort: 'address', limit: 10, kind: 'candidate' }).total).toBe(0);
    const ranged = pageLots(lots, { sort: 'address', limit: 10, minLotSqft: 3500, maxLotSqft: 7000 });
    expect(ranged.lots.map((l) => l.rollNumber)).toEqual(['b', 'd']);
  });

  it('rejects a malformed cursor or one minted for another sort', () => {
    expect(() => decodeCursor('not-base64-json', 'address')).toThrow(InvalidCursorError);
    const c = encodeCursor({ s: 'lot-size-desc', k: 7000, r: 'b' });
    expect(() => decodeCursor(c, 'address')).toThrow(InvalidCursorError);
    expect(decodeCursor(c, 'lot-size-desc')).toEqual({ s: 'lot-size-desc', k: 7000, r: 'b' });
  });
});
