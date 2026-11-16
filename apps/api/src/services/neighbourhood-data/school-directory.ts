/**
 * Schools directory builder (#774) — pure, no I/O.
 *
 * Merges the free public sources into ONE list of Calgary K–12 schools:
 *
 * 1. **City of Calgary "Schools"** (Socrata) — the base list: name, legal
 *    authority, grades, address, coordinates. Post-secondary rows (and the
 *    authority-less rows, which are all post-secondary) are dropped.
 * 2. **Alberta school authority list** — classifies each authority into a
 *    school type. Alberta's public, separate, francophone and charter
 *    authorities are a small closed set ({@link ALBERTA_AUTHORITIES}); every
 *    other school authority is a private (independent) school operator, so
 *    every school gets a type.
 * 3. **OpenStreetMap** (`amenity=school`) — adds private schools the City
 *    list lacks, and fills website / programs / tuition on City schools it
 *    matches. An OSM school matches a City school when the normalized names
 *    agree (equal, or one contains the other) and they sit within the
 *    configured radius. Unmatched OSM schools are kept only when OSM marks
 *    them private (`operator:type=private` or `fee=yes`) — anything else
 *    cannot be typed reliably. Unmatched OSM schools are de-duplicated
 *    among themselves the same way (node + building way for one school).
 *
 * Every field keeps the source it came from (`data.sources`). Community
 * codes come from a point-in-polygon test against City community
 * boundaries. Public data only: phone numbers and emails are never kept.
 */
import type { SchoolProgram, SchoolSourceId, SchoolType } from '@feasly/contracts';
import { haversineMeters, pointInGeometry } from '../../lib/geo';
import { websiteUrlOrNull } from '../../lib/school-sources';
import type { SchoolRecord } from './providers';

/** One Alberta school authority (or family of names for one authority). */
export interface AlbertaAuthority {
  readonly type: SchoolType;
  /** Display board name; null → show the source's authority name. */
  readonly board: string | null;
  /** Normalized name fragments (see {@link normalizeName}) that identify it. */
  readonly aliases: readonly string[];
}

/**
 * Alberta school authorities with schools in Calgary, from Alberta
 * Education's school authority list: public, separate, francophone and
 * charter authorities, plus out-of-city public divisions that run
 * alternative programs in Calgary. Not listed here → private (independent).
 */
export const ALBERTA_AUTHORITIES: readonly AlbertaAuthority[] = [
  {
    type: 'public_cbe',
    board: 'Calgary Board of Education',
    aliases: ['the calgary school division', 'calgary school division', 'calgary board of education', 'cbe'],
  },
  {
    type: 'catholic_ccsd',
    board: 'Calgary Catholic School District',
    aliases: [
      'calgary roman catholic separate school division',
      'calgary catholic school district',
      'ccsd',
    ],
  },
  {
    type: 'francophone',
    board: 'Conseil scolaire FrancoSud',
    aliases: [
      'southern francophone education region',
      'greater southern public francophone education region',
      'greater southern separate catholic francophone education region',
      'conseil scolaire francosud',
      'francosud',
    ],
  },
  // Alberta public charter schools operating in Calgary.
  {
    type: 'charter',
    board: 'Foundations for the Future Charter Academy',
    aliases: ['foundations for the future charter academy'],
  },
  { type: 'charter', board: 'Westmount Charter School', aliases: ['westmount charter school'] },
  {
    type: 'charter',
    board: 'Connect Charter School',
    aliases: ['connect charter school', 'calgary science school'],
  },
  { type: 'charter', board: "Calgary Girls' Charter School", aliases: ['calgary girls school', 'calgary girls charter school'] },
  { type: 'charter', board: 'Calgary Arts Academy', aliases: ['calgary arts academy'] },
  {
    type: 'charter',
    board: 'Almadina Language Charter Academy',
    aliases: ['almadina school society', 'almadina language charter academy'],
  },
  // Out-of-city public divisions running alternative programs in Calgary.
  {
    type: 'alternative',
    board: null,
    aliases: [
      'palliser school division',
      'palliser regional schools',
      'prairie land school division',
      'prairie land regional division',
      'pembina hills school division',
      'pembina hills public schools',
      'rocky view school division',
      'rocky view schools',
      'golden hills school division',
      'foothills school division',
      'christ the redeemer catholic separate',
    ],
  },
];

/** Program keyword patterns, matched against the name and OSM description. */
const PROGRAM_PATTERNS: ReadonlyArray<readonly [SchoolProgram, RegExp]> = [
  ['french-immersion', /french immersion|immersion fran/i],
  ['international-baccalaureate', /international baccalaureate|\bIB\b/],
  ['advanced-placement', /advanced placement|\bAP\b/],
  ['arts', /\barts?\b|ballet|dance|music|drama/i],
  ['spanish-bilingual', /spanish bilingual|bilingual spanish/i],
  ['german-bilingual', /german bilingual|bilingual german/i],
  ['mandarin-bilingual', /mandarin|chinese bilingual/i],
  ['montessori', /montessori/i],
  ['waldorf', /waldorf/i],
  ['stem', /\bSTEM\b|\bscience\b|engineering/i],
  ['sports', /\bsports?\b|athlet|hockey/i],
  ['indigenous-focus', /aboriginal|indigenous|first nations/i],
  ['traditional-learning', /traditional learning/i],
  ['dual-credit', /dual credit/i],
  ['outreach', /outreach/i],
  ['online', /\bonline\b|e-?learning|virtual|cyber/i],
];

/** Lowercase, accents and punctuation stripped, whitespace collapsed. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Name used for cross-source matching: generic words dropped. */
function matchKey(name: string): string {
  return normalizeName(name)
    .replace(/\b(the|school|ecole|elementary|junior|senior|high|middle|academy|campus|of|de|la|le)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface AuthorityClassification {
  readonly type: SchoolType;
  readonly board: string | null;
  /** True when the authority list named it; false → private by default. */
  readonly listed: boolean;
}

/** Alberta authority list lookup: listed authority → its type, else private. */
export function classifyAuthority(authority: string | null): AuthorityClassification {
  const n = authority ? normalizeName(authority) : '';
  if (n.length > 0) {
    for (const entry of ALBERTA_AUTHORITIES) {
      const hit = entry.aliases.some((alias) =>
        alias.length <= 4 ? n === alias : n === alias || n.includes(alias),
      );
      if (hit) return { type: entry.type, board: entry.board, listed: true };
    }
    // Any other authority that calls itself a charter school is one.
    if (/\bcharter\b/.test(n)) return { type: 'charter', board: null, listed: true };
  }
  return { type: 'private', board: null, listed: false };
}

/** Programs named in the given texts (stable vocabulary order). */
export function detectPrograms(...texts: ReadonlyArray<string | null | undefined>): SchoolProgram[] {
  const haystack = texts.filter((t): t is string => typeof t === 'string').join(' \n ');
  if (haystack.length === 0) return [];
  return PROGRAM_PATTERNS.filter(([, re]) => re.test(haystack)).map(([program]) => program);
}

// ── Source row shapes ────────────────────────────────────────────────────

/** City "Schools" row (Socrata). */
export type CitySchoolRow = Readonly<Record<string, unknown>>;

/** Overpass `out center tags` element. */
export interface OsmElement {
  readonly type: string;
  readonly id: number;
  readonly lat?: number;
  readonly lon?: number;
  readonly center?: { readonly lat: number; readonly lon: number };
  readonly tags?: Readonly<Record<string, string>>;
}

/** City "Community District Boundaries" row (Socrata). */
export type CommunityBoundaryRow = Readonly<Record<string, unknown>>;

export interface BuildSchoolDirectoryInput {
  readonly cityRows: readonly CitySchoolRow[];
  readonly osmElements: readonly OsmElement[];
  readonly boundaries: readonly CommunityBoundaryRow[];
  readonly dedupeRadiusM: number;
}

/** What `SchoolRecord.data` holds for a directory school. */
export interface SchoolRecordData {
  readonly authority: string | null;
  readonly programs: readonly SchoolProgram[];
  readonly address: string | null;
  readonly postalCode: string | null;
  readonly website: string | null;
  readonly tuition: boolean;
  readonly communityName: string | null;
  readonly elementary: boolean;
  readonly juniorHigh: boolean;
  readonly seniorHigh: boolean;
  readonly sources: Readonly<Record<string, SchoolSourceId>>;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function cityPoint(row: CitySchoolRow): { lat: number; lng: number } | null {
  const point = row['point'];
  if (typeof point === 'object' && point !== null) {
    const coords = (point as { coordinates?: unknown }).coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      const lng = num(coords[0]);
      const lat = num(coords[1]);
      if (lat !== null && lng !== null) return { lat, lng };
    }
  }
  const lat = num(row['latitude']);
  const lng = num(row['longitude']);
  return lat !== null && lng !== null ? { lat, lng } : null;
}

function osmPoint(el: OsmElement): { lat: number; lng: number } | null {
  if (el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) {
    return { lat: el.center.lat, lng: el.center.lon };
  }
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return { lat: el.lat, lng: el.lon };
  return null;
}

function osmAddress(tags: Readonly<Record<string, string>>): string | null {
  const street = str(tags['addr:street']);
  if (!street) return null;
  const number = str(tags['addr:housenumber']);
  return number ? `${number} ${street}` : street;
}

/** Dedupe preference: the mapped area (relation/way) over a bare node. */
function osmTypeRank(type: string): number {
  return type === 'relation' ? 0 : type === 'way' ? 1 : 2;
}

function osmIsPrivate(tags: Readonly<Record<string, string>>): boolean {
  return tags['operator:type'] === 'private' || tags['fee'] === 'yes';
}

interface Community {
  readonly code: string;
  readonly name: string | null;
  readonly geometry: unknown;
}

function communityLookup(rows: readonly CommunityBoundaryRow[]) {
  const communities: Community[] = [];
  for (const row of rows) {
    const code = str(row['comm_code']);
    const geometry = row['multipolygon'] ?? row['the_geom'];
    if (!code || !geometry) continue;
    communities.push({ code: code.toUpperCase(), name: str(row['name']), geometry });
  }
  return (lat: number, lng: number): Community | null =>
    communities.find((c) => pointInGeometry({ lat, lon: lng }, c.geometry)) ?? null;
}

/** City GUID `{8200…}` → `city-8200…` (URL-safe, stable). */
function cityId(globalId: string): string | null {
  const id = globalId.replace(/[{}]/g, '').toLowerCase();
  return /^[a-z0-9-]+$/.test(id) ? `city-${id}` : null;
}

function namesMatch(a: string, b: string): boolean {
  const ka = matchKey(a);
  const kb = matchKey(b);
  if (ka.length === 0 || kb.length === 0) return false;
  if (ka === kb) return true;
  // Containment only for a specific (2+ word) name, on whole words.
  const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return shorter.includes(' ') && ` ${longer} `.includes(` ${shorter} `);
}

/**
 * Builds the merged directory. Deterministic for the same input (stable
 * ids, stable order) so the refresh's content hash only changes when the
 * sources do.
 */
export function buildSchoolDirectory(input: BuildSchoolDirectoryInput): SchoolRecord[] {
  const findCommunity = communityLookup(input.boundaries);
  const CITY: SchoolSourceId = 'calgary-open-data';
  const AUTH: SchoolSourceId = 'alberta-authority-list';
  const OSM: SchoolSourceId = 'openstreetmap';

  const osm = input.osmElements
    .map((el) => ({ el, tags: el.tags ?? {}, point: osmPoint(el) }))
    .filter((o) => str(o.tags['name']) !== null && o.point !== null);
  const usedOsm = new Set<number>();

  const out: SchoolRecord[] = [];

  // 1) City schools (K–12 only), enriched by a matching OSM school.
  for (const row of input.cityRows) {
    const globalId = str(row['global_id']);
    const name = str(row['name']);
    const authority = str(row['board']);
    if (!globalId || !name || !authority) continue;
    if (row['postsecond'] === 'Y') continue;
    const externalId = cityId(globalId);
    if (!externalId) continue;
    const point = cityPoint(row);

    let match: (typeof osm)[number] | undefined;
    let matchIndex = -1;
    if (point) {
      let best = Infinity;
      osm.forEach((o, i) => {
        if (usedOsm.has(i) || !namesMatch(name, o.tags['name']!)) return;
        const d = haversineMeters({ lat: point.lat, lon: point.lng }, { lat: o.point!.lat, lon: o.point!.lng });
        if (d <= input.dedupeRadiusM && d < best) {
          best = d;
          match = o;
          matchIndex = i;
        }
      });
    }
    if (matchIndex >= 0) usedOsm.add(matchIndex);

    const classification = classifyAuthority(authority);
    const sources: Record<string, SchoolSourceId> = { name: CITY, authority: CITY, type: AUTH };
    const board = classification.board ?? authority;
    sources['board'] = classification.board ? AUTH : CITY;

    const cityGrades = str(row['grades']);
    const grades = cityGrades && cityGrades.toLowerCase() !== 'unknown' ? cityGrades : str(match?.tags['grades']);
    if (grades) sources['grades'] = grades === cityGrades ? CITY : OSM;

    const osmPrograms = detectPrograms(match?.tags['description'], match?.tags['name']);
    const programs = [...new Set([...detectPrograms(name), ...osmPrograms])];
    if (programs.length > 0) sources['programs'] = osmPrograms.length > 0 ? OSM : CITY;

    const address = str(row['address_ab']) ?? (match ? osmAddress(match.tags) : null);
    if (address) sources['address'] = str(row['address_ab']) ? CITY : OSM;
    const postalCode = str(row['postal_cod']) ?? str(match?.tags['addr:postcode']);

    const coords = point ?? match?.point ?? null;
    if (coords) sources['coordinates'] = point ? CITY : OSM;

    const site = websiteUrlOrNull(match?.tags['website']);
    if (site) sources['website'] = OSM;

    const fee = match?.tags['fee'];
    // Private schools charge tuition unless OSM says otherwise; public,
    // separate, francophone and charter schools never do.
    const tuition =
      classification.type === 'private'
        ? fee !== 'no'
        : classification.type === 'alternative' && fee === 'yes';
    sources['tuition'] = fee === 'yes' || fee === 'no' ? OSM : AUTH;

    const community = coords ? findCommunity(coords.lat, coords.lng) : null;
    if (community) sources['community'] = CITY;

    const data: SchoolRecordData = {
      authority,
      programs,
      address,
      postalCode,
      website: site,
      tuition,
      communityName: community?.name ?? null,
      elementary: row['elem'] === 'Y',
      juniorHigh: row['junior_h'] === 'Y',
      seniorHigh: row['senior_h'] === 'Y',
      sources,
    };
    out.push({
      externalId,
      name,
      board,
      grades,
      schoolType: classification.type,
      communityCode: community?.code ?? null,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      data: data as unknown as Record<string, unknown>,
    });
  }

  // 2) Private schools only OSM knows about. Typed only when OSM says private
  //    and no listed public authority runs it. OSM often maps one school as
  //    both a node and a building way/relation: keep one per name + location,
  //    preferring relation > way > node, then the lowest id (deterministic).
  const osmOnly = osm
    .filter((o, i) => !usedOsm.has(i) && osmIsPrivate(o.tags) && !classifyAuthority(str(o.tags['operator'])).listed)
    .sort((a, b) => osmTypeRank(a.el.type) - osmTypeRank(b.el.type) || a.el.id - b.el.id);
  const keptOsm: typeof osmOnly = [];
  for (const o of osmOnly) {
    const duplicate = keptOsm.some(
      (k) =>
        namesMatch(k.tags['name']!, o.tags['name']!) &&
        haversineMeters({ lat: k.point!.lat, lon: k.point!.lng }, { lat: o.point!.lat, lon: o.point!.lng }) <=
          input.dedupeRadiusM,
    );
    if (!duplicate) keptOsm.push(o);
  }
  keptOsm.forEach((o) => {
    const operator = str(o.tags['operator']);
    const name = o.tags['name']!;
    const point = o.point!;
    const community = findCommunity(point.lat, point.lng);
    const grades = str(o.tags['grades']);
    const programs = detectPrograms(name, o.tags['description']);
    const address = osmAddress(o.tags);
    const site = websiteUrlOrNull(o.tags['website']);
    const sources: Record<string, SchoolSourceId> = {
      name: OSM,
      type: OSM,
      board: OSM,
      coordinates: OSM,
      tuition: OSM,
    };
    if (operator) sources['authority'] = OSM;
    if (grades) sources['grades'] = OSM;
    if (programs.length > 0) sources['programs'] = OSM;
    if (address) sources['address'] = OSM;
    if (site) sources['website'] = OSM;
    if (community) sources['community'] = CITY;
    const data: SchoolRecordData = {
      authority: operator,
      programs,
      address,
      postalCode: str(o.tags['addr:postcode']),
      website: site,
      tuition: o.tags['fee'] !== 'no',
      communityName: community?.name ?? null,
      elementary: false,
      juniorHigh: false,
      seniorHigh: false,
      sources,
    };
    out.push({
      externalId: `osm-${o.el.type}-${o.el.id}`,
      name,
      board: operator ?? name,
      grades,
      schoolType: 'private',
      communityCode: community?.code ?? null,
      lat: point.lat,
      lng: point.lng,
      data: data as unknown as Record<string, unknown>,
    });
  });

  return out.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
}
