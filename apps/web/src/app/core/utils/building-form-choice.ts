import type {
  BuildingForm,
  FormPermission,
  ZoningDistrict,
  ZoningDistrictsResponse,
} from '@feasly/contracts';

/** One card in the scope step's "What do you want to build?" choice (#689). */
export interface BuildingFormOption {
  readonly form: BuildingForm;
  /** True when the cost engine can estimate this form today (API-owned list). */
  readonly estimable: boolean;
  /** Permitted / discretionary per the catalogue; absent on fail-open options. */
  readonly permission?: FormPermission;
}

/**
 * The choice for one lot.
 * - `covered`: the lot's district is in the catalogue; `options` are the
 *   forms it typically allows (estimable first, then "coming soon").
 * - `fail-open`: unknown district, Direct Control or a district the
 *   catalogue does not cover. Only the estimable forms are offered and
 *   nothing is blocked; the request then names no form (legacy behaviour).
 */
export interface BuildingFormChoice {
  readonly status: 'covered' | 'fail-open';
  /** The catalogue's district code (covered) or the lot's code verbatim. */
  readonly districtCode: string;
  readonly options: readonly BuildingFormOption[];
  /** Where to confirm the rules (the City's bylaw page). */
  readonly sourceUrl: string;
}

const DASHES = /[‐-―−﹘﹣－]/g;
/** Calgary-style modifier suffixes (`d75`, `h16`, `f3.0`) after a base code. */
const MODIFIERS = /^(?:[FHD]\d+(?:\.\d+)?)+$/;

/** Same canonical key the API resolver uses: no spaces, ASCII dash, upper case. */
function normalize(code: string): string {
  return code.replace(DASHES, '-').replace(/\s+/g, '').toUpperCase();
}

/**
 * Finds the lot's district in the catalogue by code or alias, then by base
 * code + modifier suffix (`M-CGd75` → `M-CG`). A miss is not an error: the
 * caller fails open.
 */
export function findDistrict(
  catalogue: ZoningDistrictsResponse,
  zoning: string | null | undefined,
): ZoningDistrict | undefined {
  const key = normalize(zoning ?? '');
  if (!key) return undefined;
  const keysOf = (d: ZoningDistrict): string[] => [d.code, ...d.aliases].map(normalize);
  const exact = catalogue.districts.find((d) => keysOf(d).includes(key));
  if (exact) return exact;
  let best: { district: ZoningDistrict; length: number } | undefined;
  for (const district of catalogue.districts) {
    for (const k of keysOf(district)) {
      if (key.startsWith(k) && MODIFIERS.test(key.slice(k.length))) {
        if (!best || k.length > best.length) best = { district, length: k.length };
      }
    }
  }
  return best?.district;
}

/**
 * Builds the building-form choice for a lot from the API's catalogue. Pure
 * presentation mapping: which forms exist, which are allowed and which are
 * estimable all come from the API — this function names no district or form.
 * Returns null without a catalogue (the step then hides the choice).
 */
export function buildingFormChoice(
  catalogue: ZoningDistrictsResponse | null | undefined,
  zoning: string | null | undefined,
): BuildingFormChoice | null {
  if (!catalogue) return null;
  const estimable = new Set(catalogue.estimableBuildingForms);
  const district = findDistrict(catalogue, zoning);
  if (district && district.coverage === 'covered' && district.forms.length > 0) {
    const options = district.forms.map((f) => ({
      form: f.form,
      estimable: estimable.has(f.form),
      permission: f.permission,
    }));
    return {
      status: 'covered',
      districtCode: district.code,
      sourceUrl: catalogue.sourceUrl,
      // Stable sort: estimable forms first, catalogue order otherwise.
      options: [...options.filter((o) => o.estimable), ...options.filter((o) => !o.estimable)],
    };
  }
  return {
    status: 'fail-open',
    districtCode: district?.code ?? (zoning ?? '').trim(),
    sourceUrl: catalogue.sourceUrl,
    options: catalogue.estimableBuildingForms.map((form) => ({ form, estimable: true })),
  };
}

/**
 * The form to send with the estimate request, or undefined to send none.
 * Covered lots send the chosen estimable form (or the first estimable one);
 * fail-open lots send none, so the API's legacy single-detached path runs
 * unchanged and no district check can block the user.
 */
export function requestBuildingForm(
  choice: BuildingFormChoice | null,
  chosen: BuildingForm | undefined,
): BuildingForm | undefined {
  if (!choice || choice.status !== 'covered') return undefined;
  const estimable = choice.options.filter((o) => o.estimable);
  return estimable.find((o) => o.form === chosen)?.form ?? estimable[0]?.form;
}
