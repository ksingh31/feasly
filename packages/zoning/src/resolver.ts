/**
 * Pure zoning resolver (issue #687): district code → building forms + key
 * rules, from versioned per-city catalogues. Zero I/O, zero deps, no clock:
 * the caller passes `asOf` when it wants a dated version.
 *
 * Rules the resolver guarantees:
 * - Unverified values never leave it (forms and rules alike).
 * - Unknown, blank or ambiguous codes fail open: status `unknown`, no data.
 * - `DC` resolves to `site-specific` (rules live in the parcel's DC bylaw).
 * - Case, stray spaces and typographic dashes don't matter (`R-C1S` = `R-C1s`).
 * - Aliases (other spellings, legacy codes) resolve to their district.
 * - Calgary-style modifiers (`M-CGd75`, `MU-1f3.0h16`) resolve to the base
 *   district; a density (`d`) or height (`h`) modifier replaces that rule, so
 *   the catalogue value is dropped rather than shown wrong.
 * - It computes no dollars. The only arithmetic is the indicative unit count.
 *
 * Adding a city needs no change here: pass another `ZoningRulesVersion`.
 */
import type {
  ZoningDistrict,
  ZoningDistrictSource,
  ZoningDistrictsResponse,
  ZoningForm,
  ZoningKeyRules,
  ZoningKeyRulesSource,
  ZoningRule,
  ZoningRuleSource,
  ZoningRulesVersion,
} from '@feasly/contracts';

/** Lot facts the resolver can use. All optional. */
export interface ZoningLot {
  /** Parcel area in square metres. */
  readonly areaSqm?: number;
}

export type ZoningResolutionStatus = 'covered' | 'site-specific' | 'not-covered' | 'unknown';

/** Which catalogue answered. */
export interface ZoningSource {
  readonly city: string;
  readonly effectiveDate: string;
  readonly bylaw: string;
  readonly bylawVersion: string;
  readonly sourceUrl: string;
}

/** Density × lot area, floored to whole units. Indicative only. */
export interface IndicativeUnitCount {
  readonly value: number;
  readonly densityUnitsPerHa: number;
  readonly lotAreaSqm: number;
  /** Section of the density rule the count comes from. */
  readonly section: string;
}

export interface ZoningResolution {
  readonly status: ZoningResolutionStatus;
  /** The code as asked (trimmed). */
  readonly requestedCode: string;
  /** Absent when the city has no catalogue. */
  readonly source?: ZoningSource;
  /** How the code matched; absent when unknown. */
  readonly matchedBy?: 'code' | 'alias' | 'modifier';
  /** Modifier suffix stripped to find the district, e.g. "d75". */
  readonly modifiers?: string;
  /** Verified-only district data; absent when unknown. */
  readonly district?: ZoningDistrict;
  /** Only when the district sets a verified density and a lot area is given. */
  readonly indicativeMaxUnits?: IndicativeUnitCount;
}

/**
 * The catalogue as this package can answer it: everything in the API
 * response except `estimableBuildingForms`, which comes from the cost engine
 * (#689) and is added by the API's zoning service.
 */
export type ZoningCatalogue = Omit<ZoningDistrictsResponse, 'estimableBuildingForms'>;

export interface ResolveOptions {
  /** ISO date; picks the newest version in effect on that date. Default: newest. */
  readonly asOf?: string;
}

export interface ZoningResolver {
  /** Cities with at least one catalogue. */
  cities(): readonly string[];
  /** Verified-only catalogue for a city, or undefined when there is none. */
  catalogue(city: string, opts?: ResolveOptions): ZoningCatalogue | undefined;
  resolve(
    city: string,
    districtCode: string | null | undefined,
    lot?: ZoningLot,
    opts?: ResolveOptions,
  ): ZoningResolution;
}

const DASHES = /[‐-―−﹘﹣－]/g;
const MODIFIERS = /^(?:[FHD]\d+(?:\.\d+)?)+$/;
const SQM_PER_HECTARE = 10_000;
/** Absorbs binary floating-point error before flooring (e.g. 2.9999999996). */
const FLOOR_EPSILON = 1e-9;

/** Canonical lookup key: trimmed, no whitespace, ASCII dash, upper case. */
export function normalizeDistrictCode(code: string): string {
  return code.replace(DASHES, '-').replace(/\s+/g, '').toUpperCase();
}

function publicRule(r: ZoningRuleSource | undefined): ZoningRule | undefined {
  if (!r || !r.verified) return undefined;
  return r.note === undefined
    ? { value: r.value, section: r.section }
    : { value: r.value, section: r.section, note: r.note };
}

function publicRules(rules: ZoningKeyRulesSource): ZoningKeyRules {
  const out: {
    maxHeightM?: ZoningRule;
    maxLotCoveragePct?: ZoningRule;
    maxDensityUnitsPerHa?: ZoningRule;
    maxUnitsOnLot?: ZoningRule;
  } = {};
  const height = publicRule(rules.maxHeightM);
  const coverage = publicRule(rules.maxLotCoveragePct);
  const density = publicRule(rules.maxDensityUnitsPerHa);
  const units = publicRule(rules.maxUnitsOnLot);
  if (height) out.maxHeightM = height;
  if (coverage) out.maxLotCoveragePct = coverage;
  if (density) out.maxDensityUnitsPerHa = density;
  if (units) out.maxUnitsOnLot = units;
  return out;
}

/** Project a source district to its verified-only public shape. */
export function toPublicDistrict(d: ZoningDistrictSource): ZoningDistrict {
  const forms: ZoningForm[] = d.forms
    .filter((f) => f.verified)
    .map((f) =>
      f.note === undefined
        ? { form: f.form, permission: f.permission, section: f.section }
        : { form: f.form, permission: f.permission, section: f.section, note: f.note },
    );
  const base = {
    code: d.code,
    name: d.name,
    category: d.category,
    coverage: d.coverage,
    aliases: [...(d.aliases ?? [])],
    forms,
    rules: publicRules(d.rules),
  };
  return d.note === undefined ? base : { ...base, note: d.note };
}

interface IndexedVersion {
  readonly version: ZoningRulesVersion;
  readonly byKey: ReadonlyMap<string, { district: ZoningDistrictSource; alias: boolean }>;
}

function indexVersion(v: ZoningRulesVersion): IndexedVersion {
  const byKey = new Map<string, { district: ZoningDistrictSource; alias: boolean }>();
  const add = (key: string, district: ZoningDistrictSource, alias: boolean): void => {
    const k = normalizeDistrictCode(key);
    const prior = byKey.get(k);
    if (prior && prior.district !== district) {
      throw new Error(
        `zoning catalogue ${v.city}/${v.effectiveDate}: "${key}" maps to both ` +
          `${prior.district.code} and ${district.code}`,
      );
    }
    byKey.set(k, { district, alias });
  };
  for (const d of v.districts) {
    add(d.code, d, false);
    for (const a of d.aliases ?? []) add(a, d, true);
  }
  return { version: v, byKey };
}

function sourceOf(v: ZoningRulesVersion): ZoningSource {
  return {
    city: v.city,
    effectiveDate: v.effectiveDate,
    bylaw: v.bylaw,
    bylawVersion: v.bylawVersion,
    sourceUrl: v.sourceUrl,
  };
}

/** Drop rules a modifier overrides (d → density, h → height). */
function applyModifiers(district: ZoningDistrict, modifiers: string): ZoningDistrict {
  const rules: {
    maxHeightM?: ZoningRule;
    maxLotCoveragePct?: ZoningRule;
    maxDensityUnitsPerHa?: ZoningRule;
    maxUnitsOnLot?: ZoningRule;
  } = { ...district.rules };
  if (modifiers.includes('d')) delete rules.maxDensityUnitsPerHa;
  if (modifiers.includes('h')) delete rules.maxHeightM;
  return { ...district, rules };
}

function indicativeUnits(
  district: ZoningDistrict,
  lot: ZoningLot | undefined,
): IndicativeUnitCount | undefined {
  const density = district.rules.maxDensityUnitsPerHa;
  const area = lot?.areaSqm;
  if (!density || area === undefined || !Number.isFinite(area) || area <= 0) return undefined;
  let value = Math.floor((density.value * area) / SQM_PER_HECTARE + FLOOR_EPSILON);
  const cap = district.rules.maxUnitsOnLot;
  if (cap) value = Math.min(value, cap.value);
  // A count under one unit says nothing useful about the lot.
  if (value < 1) return undefined;
  return {
    value,
    densityUnitsPerHa: density.value,
    lotAreaSqm: area,
    section: density.section,
  };
}

export function createZoningResolver(catalogues: readonly ZoningRulesVersion[]): ZoningResolver {
  const byCity = new Map<string, IndexedVersion[]>();
  for (const v of catalogues) {
    const city = v.city.toLowerCase();
    const list = byCity.get(city) ?? [];
    if (list.some((x) => x.version.effectiveDate === v.effectiveDate)) {
      throw new Error(`zoning catalogue ${city}/${v.effectiveDate} registered twice`);
    }
    list.push(indexVersion(v));
    // Newest first.
    list.sort((a, b) => b.version.effectiveDate.localeCompare(a.version.effectiveDate));
    byCity.set(city, list);
  }

  const active = (city: string, opts?: ResolveOptions): IndexedVersion | undefined => {
    const list = byCity.get(city.trim().toLowerCase());
    if (!list) return undefined;
    const asOf = opts?.asOf;
    return asOf === undefined ? list[0] : list.find((x) => x.version.effectiveDate <= asOf);
  };

  return {
    cities: () => [...byCity.keys()].sort(),

    catalogue: (city, opts) => {
      const iv = active(city, opts);
      if (!iv) return undefined;
      return {
        ...sourceOf(iv.version),
        districts: iv.version.districts.map(toPublicDistrict),
      };
    },

    resolve: (city, districtCode, lot, opts) => {
      const requestedCode = (districtCode ?? '').trim();
      const iv = active(city, opts);
      if (!iv) return { status: 'unknown', requestedCode };
      const source = sourceOf(iv.version);
      const key = normalizeDistrictCode(requestedCode);
      if (key.length === 0) return { status: 'unknown', requestedCode, source };

      const direct = iv.byKey.get(key);
      if (direct) {
        const district = toPublicDistrict(direct.district);
        const units = indicativeUnits(district, lot);
        return {
          status: direct.district.coverage,
          requestedCode,
          source,
          matchedBy: direct.alias ? 'alias' : 'code',
          district,
          ...(units ? { indicativeMaxUnits: units } : {}),
        };
      }

      // Longest known base whose remainder is a modifier suffix.
      for (let i = key.length - 1; i > 0; i--) {
        const rest = key.slice(i);
        if (!MODIFIERS.test(rest)) continue;
        const hit = iv.byKey.get(key.slice(0, i));
        if (!hit) continue;
        const modifiers = rest.replace(/[FHD]/g, (c) => c.toLowerCase());
        const district = applyModifiers(toPublicDistrict(hit.district), modifiers);
        const units = indicativeUnits(district, lot);
        return {
          status: hit.district.coverage,
          requestedCode,
          source,
          matchedBy: 'modifier',
          modifiers,
          district,
          ...(units ? { indicativeMaxUnits: units } : {}),
        };
      }

      return { status: 'unknown', requestedCode, source };
    },
  };
}
