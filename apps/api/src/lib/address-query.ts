/**
 * Address-query normalisation for the City autocomplete (#701).
 *
 * Pure: no I/O, no clock, no env. Turns what a homeowner types into the shape
 * the City assessment dataset (4bsw-nn7w) stores — uppercase, single-spaced,
 * two-letter street types and quadrants, units as "UNIT BUILDING STREET"
 * ("201 1234 17 AV SW") — and classifies the query so a miss can carry a
 * specific reason (postal code, unit, no house number).
 *
 * The City stores every address as "[UNIT ]HOUSE STREET TYPE QUADRANT"
 * (verified against the live dataset 2026-11-15: "1412 PROSPECT AV SW",
 * "101 1107 17 AV SW", "2 66 BENY-SUR-MER RD SW"), so hyphens inside street
 * names are kept and only a leading "unit-house" pair is split.
 *
 * Tested table-driven in test/address-query.test.ts.
 */

/** What the query looks like — drives the miss reason and the fallback. */
export type AddressQueryKind = 'address' | 'unit' | 'no_house_number' | 'postal_code';

export interface NormalizedAddressQuery {
  /** Prefix-search key in City format ("201 1234 17 AV SW"); '' when nothing searchable. */
  readonly search: string;
  readonly kind: AddressQueryKind;
  /** Building house number ("1234"), null when the query does not start with one. */
  readonly houseNumber: string | null;
  /** Street-name tokens between house number and type/quadrant ("17", "PROSPECT"). */
  readonly streetName: string | null;
  /** Unit typed by the user ("201"), null when none. Kept for display, never logged. */
  readonly unit: string | null;
  /** Forward sortation area of a postal-code-only query ("T2T"), else null. */
  readonly postalFsa: string | null;
}

/**
 * Natural street-type spellings users type, mapped to the abbreviations the
 * City dataset actually stores. Sourced from the City of Calgary's official
 * STREET_TYPE list plus a live sample of the assessment dataset 4bsw-nn7w:
 * every street-type token observed is a two-letter abbreviation ("1600 90 AV
 * SW", never "AVE").
 */
const STREET_TYPE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  ALLEY: 'AL', AVENUE: 'AV', AVE: 'AV', BAY: 'BA', BOULEVARD: 'BV', BLVD: 'BV',
  CAPE: 'CA', CENTRE: 'CE', CTR: 'CE', CIRCLE: 'CI', CIR: 'CI', CLOSE: 'CL',
  COMMON: 'CM', COURT: 'CO', CRT: 'CO', COVE: 'CV', CRESCENT: 'CR', CRES: 'CR',
  DRIVE: 'DR', GATE: 'GA', GARDEN: 'GD', GARDENS: 'GD', GREEN: 'GR', GROVE: 'GV',
  HEATH: 'HE', HEIGHTS: 'HT', HIGHWAY: 'HI', HWY: 'HI', HILL: 'HL', ISLAND: 'IS',
  ISLE: 'IS', LANDING: 'LD', LANE: 'LN', LINK: 'LI', MANOR: 'MR', MEWS: 'ME',
  MOUNT: 'MT', PARADE: 'PR', PARK: 'PA', PARKWAY: 'PY', PKY: 'PY', PASS: 'PS',
  PASSAGE: 'PS', PATH: 'PH', PLACE: 'PL', PLAZA: 'PZ', PLZ: 'PZ', POINT: 'PT',
  RISE: 'RI', ROAD: 'RD', ROW: 'RO', SQUARE: 'SQ', STREET: 'ST', TERRACE: 'TC',
  TERR: 'TC', TRAIL: 'TR', VIEW: 'VW', VILLA: 'VI', VILLAS: 'VI', WALK: 'WK',
  WAY: 'WY',
};

/** Abbreviations the dataset stores — a token already in this set is a street type. */
const STREET_TYPES = new Set(Object.values(STREET_TYPE_ABBREVIATIONS));

/** Spelled-out single-token quadrants. */
const QUADRANT_WORDS: Readonly<Record<string, string>> = {
  NORTHWEST: 'NW', NORTHEAST: 'NE', SOUTHWEST: 'SW', SOUTHEAST: 'SE',
};

/** Two-token quadrants ("SOUTH WEST", "S W") keyed as "FIRST SECOND". */
const QUADRANT_PAIRS: Readonly<Record<string, string>> = {
  'NORTH WEST': 'NW', 'NORTH EAST': 'NE', 'SOUTH WEST': 'SW', 'SOUTH EAST': 'SE',
  'N W': 'NW', 'N E': 'NE', 'S W': 'SW', 'S E': 'SE',
};

const QUADRANT = /^(NW|NE|SW|SE)$/;
const HOUSE_NUMBER = /^\d+[A-Z]?$/;
const ORDINAL = /^(\d+)(ST|ND|RD|TH)$/;
const UNIT_WORD = '(?:UNIT|SUITE|STE|APT|APARTMENT|NO)';

/** Canadian postal code anywhere in the query (space optional). */
const POSTAL_CODE = /\b([ABCEGHJ-NPR-TV-Z]\d[ABCEGHJ-NPR-TV-Z])\s?\d[ABCEGHJ-NPR-TV-Z]\d\b/;

/** Leading unit: "#201 1234 …", "UNIT 201 1234 …", "SUITE #5 …". */
const LEADING_UNIT = new RegExp(`^(?:#\\s*|${UNIT_WORD}\\s+#?\\s*)([0-9A-Z]+)\\s+(\\d.*)$`);
/** Leading "unit-house": "201-1234 17 AV SW", "201 - 1234 …". */
const DASHED_UNIT = /^(\d+[A-Z]?)\s*-\s*(\d+[A-Z]?\s.*)$/;
/** Trailing unit: "1234 17 AV SW #201", "… UNIT 201", "… APT 3B". */
const TRAILING_UNIT = new RegExp(`^(\\d.*?)\\s+(?:#\\s*|${UNIT_WORD}\\s+#?\\s*)([0-9A-Z]+)$`);

/** Drops a trailing ", Calgary, AB" / " Calgary" / ", AB" tail. */
function stripCityTail(text: string): string {
  return text
    .replace(/,?\s*CALGARY\s*,?\s*(AB|ALBERTA)\s*$/, '')
    .replace(/,?\s*CALGARY\s*$/, '')
    .replace(/,\s*(AB|ALBERTA)\s*$/, '')
    .trim();
}

/** Uppercases and folds punctuation: periods vanish ("S.W." → "SW"), the rest become spaces. */
function cleanPunctuation(text: string): string {
  return text
    .replace(/\./g, '')
    .replace(/[^A-Z0-9#'\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rewrites quadrant, street type and ordinals on a unit-free street address. */
function normalizeStreetTokens(tokens: string[]): string[] {
  const out = tokens.map((token, index) => {
    const ordinal = index > 0 ? ORDINAL.exec(token) : null;
    return ordinal ? ordinal[1] : token;
  });
  // Quadrant: spelled-out / split forms at the end collapse to "SW".
  if (out.length >= 3) {
    const pair = QUADRANT_PAIRS[`${out[out.length - 2]} ${out[out.length - 1]}`];
    if (pair !== undefined) out.splice(out.length - 2, 2, pair);
  }
  if (out.length >= 2) {
    const word = QUADRANT_WORDS[out[out.length - 1]];
    if (word !== undefined) out[out.length - 1] = word;
  }
  // Street type: the token right before the quadrant, else the last token.
  const typeIndex =
    out.length >= 2 && QUADRANT.test(out[out.length - 1]) ? out.length - 2 : out.length - 1;
  if (typeIndex >= 1) {
    const abbreviation = STREET_TYPE_ABBREVIATIONS[out[typeIndex]];
    if (abbreviation !== undefined) out[typeIndex] = abbreviation;
  }
  return out;
}

/** House number + street-name tokens of a normalised street address. */
function splitStreet(tokens: readonly string[]): { houseNumber: string | null; streetName: string | null } {
  if (tokens.length === 0 || !HOUSE_NUMBER.test(tokens[0])) {
    return { houseNumber: null, streetName: null };
  }
  let end = tokens.length;
  if (end > 2 && QUADRANT.test(tokens[end - 1])) end -= 1;
  if (end > 2 && STREET_TYPES.has(tokens[end - 1])) end -= 1;
  const name = tokens.slice(1, end).join(' ');
  return { houseNumber: tokens[0], streetName: name || null };
}

/** Normalises and classifies one autocomplete query. */
export function normalizeAddressQuery(query: string): NormalizedAddressQuery {
  let text = query.trim().replace(/\s+/g, ' ').toUpperCase();

  // A postal code alone is not searchable (the dataset has no postal column);
  // one trailing a street address is just dropped.
  const postal = POSTAL_CODE.exec(text);
  if (postal) {
    const rest = stripCityTail(cleanPunctuation(text.replace(POSTAL_CODE, ' ')));
    if (rest.replace(/[^A-Z0-9]/g, '') === '') {
      return {
        search: '', kind: 'postal_code', houseNumber: null, streetName: null,
        unit: null, postalFsa: postal[1],
      };
    }
    text = text.replace(POSTAL_CODE, ' ');
  }

  text = cleanPunctuation(stripCityTail(text));
  text = stripCityTail(text);

  let unit: string | null = null;
  let street = text;
  const leading = LEADING_UNIT.exec(text) ?? DASHED_UNIT.exec(text);
  const trailing = leading ? null : TRAILING_UNIT.exec(text);
  if (leading) {
    unit = leading[1];
    street = leading[2];
  } else if (trailing) {
    unit = trailing[2];
    street = trailing[1];
  }
  street = street.replace(/#/g, ' ').replace(/\s+/g, ' ').trim();

  const tokens = street === '' ? [] : normalizeStreetTokens(street.split(' '));
  const { houseNumber, streetName } = splitStreet(tokens);
  const streetKey = tokens.join(' ');
  const search = unit !== null && streetKey !== '' ? `${unit} ${streetKey}` : streetKey;

  const kind: AddressQueryKind =
    unit !== null ? 'unit' : houseNumber === null ? 'no_house_number' : 'address';
  return { search, kind, houseNumber, streetName, unit, postalFsa: null };
}
