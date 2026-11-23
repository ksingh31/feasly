/**
 * Schools directory builder (#774): one list from City Schools + Alberta
 * authority list + OpenStreetMap, every school typed (AC1), de-duplicated
 * across sources by name + location, with per-field source attribution (AC3).
 */
import { describe, expect, it } from 'vitest';
import {
  buildSchoolDirectory,
  classifyAuthority,
  detectPrograms,
  normalizeName,
  osmIsK12,
  type OsmElement,
  type SchoolRecordData,
} from '../src/services/neighbourhood-data/school-directory';
import { websiteUrlOrNull } from '../src/lib/school-sources';
import { pointInGeometry } from '../src/lib/geo';

function city(id: string, name: string, board: string | null, lng: number, lat: number, extra: Record<string, unknown> = {}) {
  return {
    global_id: `{${id}}`,
    name,
    board,
    address_ab: `${id} Street SW`,
    postal_cod: 'T2T0A0',
    phone_no: '(403) 555-0100',
    email: 'office@example.org',
    grades: 'Elementary',
    elem: 'Y',
    junior_h: 'N',
    senior_h: 'N',
    postsecond: 'N',
    point: { type: 'Point', coordinates: [lng, lat] },
    ...extra,
  };
}

function osm(id: number, lat: number, lon: number, tags: Record<string, string>): OsmElement {
  return { type: 'way', id, center: { lat, lon }, tags: { amenity: 'school', ...tags } };
}

const BOUNDARIES = [
  {
    comm_code: 'ALT',
    name: 'ALTADORE',
    multipolygon: {
      type: 'MultiPolygon',
      coordinates: [[[[-114.11, 51.0], [-114.08, 51.0], [-114.08, 51.03], [-114.11, 51.03], [-114.11, 51.0]]]],
    },
  },
];

const CITY_ROWS = [
  city('A1', 'Altadore School', 'The Calgary School Division', -114.098, 51.012),
  city('B2', 'St. Mary Elementary', 'The Calgary Roman Catholic Separate School Division', -114.09, 51.02),
  city('C3', 'École de la Source', 'The Southern Francophone Education Region', -114.2, 51.1),
  city('D4', 'Westmount Charter Mid-High', 'Westmount Charter School Society', -114.15, 51.08),
  city('E5', 'Webber Academy', 'Webber Academy Foundation', -114.2256, 51.0437, { grades: 'Unknown' }),
  city('F6', 'Calgary Christian School', 'The Palliser School Division', -114.12, 51.0),
  // Post-secondary and authority-less rows are not K–12.
  city('G7', 'Bow Valley College', null, -114.06, 51.05, { postsecond: 'Y' }),
  city('H8', 'Some College', 'Some Society', -114.06, 51.05, { postsecond: 'Y' }),
];

const OSM = [
  // Same school as City 'Webber Academy' (~10 m away) — merged, not duplicated.
  osm(1, 51.04375, -114.22555, {
    name: 'Webber Academy',
    'operator:type': 'private',
    fee: 'yes',
    grades: 'K-12',
    website: 'https://www.webberacademy.ca/',
  }),
  // Same school as City 'Altadore School'; adds website + programs.
  osm(2, 51.0121, -114.0981, {
    name: 'Altadore Elementary School',
    operator: 'Calgary Board of Education',
    'operator:type': 'public',
    website: 'altadore.cbe.ab.ca',
    description: 'Programs: Regular, French Immersion',
  }),
  // Private school the City list lacks — added.
  osm(3, 51.0179, -114.1046, {
    name: 'Lycée International de Calgary',
    operator: 'Lycée Louis Pasteur Society',
    'operator:type': 'private',
    grades: '0-12',
    'addr:housenumber': '4099',
    'addr:street': 'Garrison Boulevard SW',
    'addr:postcode': 'T2T 6G2',
    website: 'https://www.lycee.ca/',
    phone: '+1-403-243-5420',
    email: 'bureau@lycee.ca',
  }),
  // OSM-only public school — cannot be typed from OSM alone: dropped.
  osm(4, 51.2, -114.0, { name: 'Unlisted Public School', 'operator:type': 'public' }),
  // OSM-only, no operator info — dropped.
  osm(5, 51.21, -114.01, { name: 'Mystery School' }),
  // Same name as a City school but 5 km away: not the same school.
  osm(6, 51.06, -114.05, { name: 'St. Mary Elementary', 'operator:type': 'private' }),
];

function build() {
  return buildSchoolDirectory({ cityRows: CITY_ROWS, osmElements: OSM, boundaries: BOUNDARIES, dedupeRadiusM: 300 });
}

function byName(name: string) {
  const found = build().filter((s) => s.name === name);
  expect(found, name).toHaveLength(1);
  return { ...found[0]!, data: found[0]!.data as unknown as SchoolRecordData };
}

describe('schools directory builder (#774)', () => {
  it('AC1: every school has a type; private and charter schools are flagged', () => {
    const rows = build();
    expect(rows.every((r) => typeof r.schoolType === 'string')).toBe(true);
    const types = Object.fromEntries(rows.map((r) => [r.externalId, r.schoolType]));
    expect(types).toEqual({
      'city-a1': 'public_cbe',
      'city-b2': 'catholic_ccsd',
      'city-c3': 'francophone',
      'city-d4': 'charter',
      'city-e5': 'private',
      'city-f6': 'alternative',
      'osm-way-3': 'private',
      'osm-way-6': 'private',
    });
    expect(byName('Webber Academy').data.tuition).toBe(true);
    expect(byName('Westmount Charter Mid-High').data.tuition).toBe(false);
    expect(byName('Altadore School').data.tuition).toBe(false);
  });

  it('drops post-secondary and authority-less rows (K–12 only)', () => {
    const names = build().map((r) => r.name);
    expect(names).not.toContain('Bow Valley College');
    expect(names).not.toContain('Some College');
  });

  it('de-duplicates across sources by name + location and merges fields', () => {
    const rows = build();
    expect(rows.filter((r) => /webber/i.test(r.name))).toHaveLength(1);
    const webber = byName('Webber Academy');
    expect(webber.externalId).toBe('city-e5');
    expect(webber.grades).toBe('K-12'); // City says "Unknown" → OSM fills it
    expect(webber.data.website).toBe('https://www.webberacademy.ca/');

    const altadore = byName('Altadore School');
    expect(altadore.data.website).toBe('https://altadore.cbe.ab.ca/');
    expect(altadore.data.programs).toEqual(['french-immersion']);
    // A same-named school far away stays a separate school.
    expect(rows.filter((r) => r.name === 'St. Mary Elementary')).toHaveLength(2);
    // Unmatched OSM schools that are not private are dropped.
    expect(rows.map((r) => r.name)).not.toContain('Unlisted Public School');
    expect(rows.map((r) => r.name)).not.toContain('Mystery School');
  });

  it('AC3: keeps a source per field', () => {
    expect(byName('Altadore School').data.sources).toEqual({
      name: 'calgary-open-data',
      authority: 'calgary-open-data',
      type: 'alberta-authority-list',
      board: 'alberta-authority-list',
      grades: 'calgary-open-data',
      programs: 'openstreetmap',
      address: 'calgary-open-data',
      coordinates: 'calgary-open-data',
      website: 'openstreetmap',
      tuition: 'alberta-authority-list',
      community: 'calgary-open-data',
    });
    const webber = byName('Webber Academy');
    expect(webber.data.sources['grades']).toBe('openstreetmap');
    expect(webber.data.sources['tuition']).toBe('openstreetmap');
    const lycee = byName('Lycée International de Calgary');
    expect(lycee.data.sources).toMatchObject({
      name: 'openstreetmap',
      type: 'openstreetmap',
      address: 'openstreetmap',
      website: 'openstreetmap',
      community: 'calgary-open-data',
    });
    expect(lycee).toMatchObject({
      board: 'Lycée Louis Pasteur Society',
      grades: '0-12',
      communityCode: 'ALT',
      data: { address: '4099 Garrison Boulevard SW', postalCode: 'T2T 6G2', tuition: true },
    });
  });

  it('keeps one OSM-only school when OSM maps it as both a node and a way', () => {
    const lycee = OSM[2]!;
    const node: OsmElement = { type: 'node', id: 99, lat: 51.018, lon: -114.1045, tags: lycee.tags };
    const rows = buildSchoolDirectory({
      cityRows: CITY_ROWS,
      osmElements: [node, ...OSM],
      boundaries: BOUNDARIES,
      dedupeRadiusM: 300,
    });
    const lycees = rows.filter((r) => r.name === 'Lycée International de Calgary');
    expect(lycees.map((r) => r.externalId)).toEqual(['osm-way-3']);
  });

  it('#922: de-duplicates OSM-only schools by normalized name + proximity, not exact tags', () => {
    // Node spells the name without accents/with "School", tags only fee=yes.
    const node: OsmElement = {
      type: 'node',
      id: 98,
      lat: 51.0181,
      lon: -114.1049,
      tags: { amenity: 'school', name: 'Lycee International de Calgary School', fee: 'yes', grades: 'K-12' },
    };
    // Same-name school 10 km away is a different campus: kept.
    const farCampus = osm(97, 51.11, -114.2, { name: 'Lycée International de Calgary', fee: 'yes', grades: 'K-6' });
    const rows = buildSchoolDirectory({
      cityRows: CITY_ROWS,
      osmElements: [node, farCampus, ...OSM],
      boundaries: BOUNDARIES,
      dedupeRadiusM: 300,
    });
    const lycees = rows.filter((r) => /^lyc/i.test(r.name)).map((r) => r.externalId);
    expect(lycees).toEqual(['osm-way-3', 'osm-way-97']);
  });

  it('#922: drops fee=yes operators without K–12 signals (tutoring centres, preschools)', () => {
    const nonK12 = [
      osm(201, 51.02, -114.1, { name: 'Kumon Math and Reading Centre', fee: 'yes', grades: '1-12' }),
      osm(202, 51.021, -114.1, { name: 'Little Sprouts Preschool', fee: 'yes' }),
      osm(203, 51.022, -114.1, { name: 'Bright Minds Pre-School', 'operator:type': 'private' }),
      osm(204, 51.023, -114.1, { name: 'Sylvan Learning', fee: 'yes' }),
      osm(205, 51.024, -114.1, { name: 'Elite Tutoring Academy', fee: 'yes' }),
      osm(206, 51.025, -114.1, { name: 'Sunrise Montessori', fee: 'yes', 'isced:level': '0' }),
      osm(207, 51.026, -114.1, { name: 'Calgary Driving School', fee: 'yes' }),
      osm(208, 51.027, -114.1, { name: 'Maple Learning Hub', fee: 'yes' }), // no K–12 signal at all
    ];
    const k12 = [
      osm(301, 51.03, -114.2, { name: 'Rundle Academy', fee: 'yes' }),
      osm(302, 51.031, -114.2, { name: 'Bow Valley Montessori', fee: 'yes', grades: 'PK-6' }),
      osm(303, 51.032, -114.2, { name: 'Prairie Heights', fee: 'yes', 'isced:level': '1;2' }),
    ];
    const rows = buildSchoolDirectory({
      cityRows: [],
      osmElements: [...nonK12, ...k12],
      boundaries: BOUNDARIES,
      dedupeRadiusM: 300,
    });
    expect(rows.map((r) => r.externalId)).toEqual(['osm-way-301', 'osm-way-302', 'osm-way-303']);
  });

  it('assigns the City community by point-in-polygon', () => {
    const altadore = byName('Altadore School');
    expect(altadore.communityCode).toBe('ALT');
    expect(altadore.data.communityName).toBe('ALTADORE');
    expect(byName('École de la Source').communityCode).toBeNull();
  });

  it('never keeps phone numbers or emails', () => {
    expect(JSON.stringify(build())).not.toMatch(/@|555-0100|243-5420/);
  });

  it('is deterministic (stable ids and order) so re-runs are idempotent', () => {
    expect(build()).toEqual(build());
    const ids = build().map((r) => r.externalId);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('osmIsK12 (#922)', () => {
  it.each<[Record<string, string>, boolean]>([
    [{ name: 'Webber Academy' }, true],
    [{ name: 'Lycée International de Calgary', grades: '0-12' }, true],
    [{ name: 'Northside Learning', grades: 'K-12' }, true],
    [{ name: 'Northside Learning', grades: 'PK-5' }, true],
    [{ name: 'Northside Learning', grades: '-1-3' }, true],
    [{ name: 'Northside Learning', grades: 'PK' }, false],
    [{ name: 'Northside Learning', school: 'secondary' }, true],
    [{ name: 'Northside Learning', 'isced:level': '1-3' }, true],
    [{ name: 'Northside Learning' }, false],
    [{ name: 'Happy Days Preschool' }, false],
    [{ name: 'Mathnasium of Calgary', grades: 'K-12' }, false],
    [{ name: 'Westside School', school: 'tutoring' }, false],
    [{ name: 'Westside School', 'isced:level': '0' }, false],
    [{ name: 'Tiny Tots Daycare School' }, false],
  ])('%j → %s', (tags, expected) => {
    expect(osmIsK12(tags)).toBe(expected);
  });
});

describe('classifyAuthority (Alberta authority list)', () => {
  it.each([
    ['The Calgary School Division', 'public_cbe'],
    ['Calgary Board of Education', 'public_cbe'],
    ['cbe', 'public_cbe'],
    ['Calgary Catholic School District', 'catholic_ccsd'],
    ['Conseil scolaire FrancoSud', 'francophone'],
    ['Foundations for the Future Charter Academy Charter School Society', 'charter'],
    ["Calgary Girls' School Society", 'charter'],
    ['Connect Charter School Society', 'charter'],
    ['Almadina School Society', 'charter'],
    ['Some New Charter Society', 'charter'],
    ['The Prairie Land School Division', 'alternative'],
    ['Rundle College Society', 'private'],
    [null, 'private'],
  ])('%s → %s', (authority, type) => {
    expect(classifyAuthority(authority).type).toBe(type);
  });

  it('short aliases match only exactly (no "cbe" inside another word)', () => {
    expect(classifyAuthority('Acbel Learning Society').type).toBe('private');
  });
});

describe('helpers', () => {
  it('detectPrograms reads the program vocabulary from free text', () => {
    expect(
      detectPrograms('Programs: Regular, Dual Credit, International Baccalaureate (IB), AP courses'),
    ).toEqual(['international-baccalaureate', 'advanced-placement', 'dual-credit']);
    expect(detectPrograms('Calgary Waldorf School')).toEqual(['waldorf']);
    expect(detectPrograms(null, undefined)).toEqual([]);
  });

  it('normalizeName strips accents, apostrophes and punctuation', () => {
    expect(normalizeName("École Sainte-Marguerite-Bourgeoys")).toBe('ecole sainte marguerite bourgeoys');
    expect(normalizeName("Calgary Girls' School")).toBe('calgary girls school');
  });

  it('websiteUrlOrNull keeps only http(s) URLs', () => {
    expect(websiteUrlOrNull('school.ca')).toBe('https://school.ca/');
    expect(websiteUrlOrNull('http://school.ca/x')).toBe('http://school.ca/x');
    expect(websiteUrlOrNull('javascript:alert(1)')).toBeNull();
    expect(websiteUrlOrNull('')).toBeNull();
  });

  it('pointInGeometry respects holes', () => {
    const donut = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
      ],
    };
    expect(pointInGeometry({ lon: 2, lat: 2 }, donut)).toBe(true);
    expect(pointInGeometry({ lon: 5, lat: 5 }, donut)).toBe(false);
    expect(pointInGeometry({ lon: 20, lat: 5 }, donut)).toBe(false);
    expect(pointInGeometry({ lon: 2, lat: 2 }, null)).toBe(false);
  });
});
