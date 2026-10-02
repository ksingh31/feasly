/**
 * Calgary coverage detection (frontend port).
 *
 * Pure helper: given a free-text address query, decides whether it carries a
 * Calgary signal, an explicit out-of-coverage signal, or neither. This is a
 * port of `apps/api/src/lib/coverage.ts` for the `live` property-data path
 * (`CalgaryAssessmentService`), which queries the City Socrata API directly
 * and never sees the backend's OUT_OF_COVERAGE contract. Same verdicts and
 * precedence as the backend; the city list uses a compact regex encoding
 * (see NON_CALGARY_CITY_PATTERN) to stay small in the main bundle. Keep the
 * token sets in sync.
 *
 * The heuristic is deliberately conservative — ambiguous input returns
 * 'ambiguous' so callers fall back to the generic not-found copy rather than
 * wrongly telling a Calgarian they're out of coverage. Callers treat an
 * out-of-coverage verdict as authoritative only AFTER a Socrata miss.
 *
 * Signals:
 * - Calgary: Canadian postal code with a T2/T3 prefix (Calgary FSAs), or an
 *   explicit "calgary" token.
 * - Out-of-coverage: a valid Canadian postal code NOT starting with T2/T3
 *   (e.g. V6B, M5V, T5J), or an explicit non-Calgary city token.
 * - Ambiguous: everything else (street addresses without city/postal).
 *
 * No I/O, no clock, no DI — inject nothing. Tested in coverage.spec.ts.
 */

/** Verdict of the coverage heuristic. */
export type CoverageSignal = 'calgary' | 'out-of-coverage' | 'ambiguous';

/**
 * Canadian postal code shape: A1A 1A1 (space optional). The first letter is
 * never D, F, I, O, Q, or U.
 */
const POSTAL_CODE =
  /\b([ABCEGHJ-NPR-TV-Z])(\d)([ABCEGHJ-NPR-TV-Z])\s?(\d)([ABCEGHJ-NPR-TV-Z])(\d)\b/i;

/** Calgary forward-sortation areas: T2* and T3*. */
const CALGARY_FSA = /^T[23]/i;

/**
 * Explicit non-Calgary city tokens — the municipalities whose residents might
 * plausibly try Feasly. Single regex alternation (compact encoding of the
 * backend's NON_CALGARY_CITIES list in apps/api/src/lib/coverage.ts — same
 * tokens, same word-boundary semantics). Word boundaries keep "victoria"
 * from firing inside "victorian"; the multi-word entries ("red deer",
 * "st. albert") match across whitespace.
 */
const NON_CALGARY_CITY_PATTERN =
  /\b(edmonton|toronto|vancouver|ottawa|montreal|winnipeg|halifax|victoria|regina|saskatoon|kelowna|red\s+deer|lethbridge|st\.\s+albert|mississauga|brampton|surrey|burnaby|richmond|coquitlam)\b/i;

/**
 * Classifies a free-text address query by coverage signal.
 *
 * Precedence: an explicit Calgary signal wins over a conflicting
 * out-of-coverage token (e.g. "Calgary, formerly Edmonton" is nonsense
 * input — treat as Calgarian and let the Socrata miss decide).
 */
export function detectCoverageSignal(input: string): CoverageSignal {  const text = input.trim();
  if (!text) return 'ambiguous';
  const lowered = text.toLowerCase();

  const postal = lowered.match(POSTAL_CODE);
  if (postal) {
    return CALGARY_FSA.test(postal[1] + postal[2]) ? 'calgary' : 'out-of-coverage';
  }

  if (/\bcalgary\b/i.test(lowered)) return 'calgary';
  if (NON_CALGARY_CITY_PATTERN.test(lowered)) return 'out-of-coverage';
  return 'ambiguous';
}

/* ── Property pricing coverage (early guard) ────────────────────────── */

/**
 * Estimate input bounds the pricing engine enforces, mirrored from the
 * cost-data file (see `limits` in AppConfig). Kept as a parameter — never a
 * literal — so the cost-data file stays the single source of truth.
 *
 * `minLotSizeSqft`/`maxLotSizeSqft` are RESERVED for future bigger-lot
 * calibration (Karan, 2026-09-28) and are NOT enforced: the estimator never
 * blocks on lot size.
 */
export interface PricingCoverageBounds {
  readonly minLotSizeSqft: number;
  readonly maxLotSizeSqft: number;
  readonly minAssessedLandValue: number;
  readonly maxAssessedLandValue: number;
}

/** Property facts a pricing-coverage check needs (subset of PropertyRecord). */
export interface PricingCoverageFacts {
  readonly lotSqft: number;
  readonly assessedValue: number;
  readonly isNonResidential: boolean;
  /** City land-use designation, verbatim (e.g. 'R-C2', 'M-C1'). Blank when unknown. */
  readonly zoning: string;
}

/**
 * Which property fact breaks pricing coverage, or null when the property
 * is priceable. Lot size is NEVER a coverage issue (Karan, 2026-09-28) —
 * any lot prices, quoted off the house size. A non-residential parcel
 * (industrial/commercial, per the City's assessment class) is checked FIRST
 * and wins over the unsupported-property-type issue, which in turn wins over
 * the assessed-value issue: the user always gets the most specific message.
 *
 * Eligibility (Karan, 2026-10-02 — final rule): the estimator quotes every
 * zone where a single-family home can legally be built. Eligible:
 * blank/unknown zoning (fail open — never block on missing data), 'DC'
 * (Direct Control — common for new-community greenfield lots, fail open),
 * 'R-C1'/'R-C1S' (single-detached), 'R-C2' (duplex — single-family homes do
 * get built in duplex-zoned areas), 'R-CG' (rowhouse), 'R-G' and 'H-GO'.
 * Rationale: per the City's Land Use Bylaw 1P2007 these are exactly the
 * districts where a single-detached dwelling is a listed use — R-CG/R-G
 * cover most inner-city infill teardown lots, which are prime rebuild
 * leads. Everything else — M-* (multi-residential), C-*, I-*, S-*, etc. —
 * is not supported.
 */
export type PricingCoverageIssue = 'non-residential' | 'unsupported-property-type' | 'assessed-value';

/**
 * Land-use designations where a single-family home can legally be built,
 * matched case-insensitively against the City `land_use_designation`.
 */
const SINGLE_FAMILY_ZONING = new Set(['R-C1', 'R-C1S', 'R-C2', 'R-CG', 'R-G', 'H-GO', 'DC']);

/**
 * True when the parcel's zoning is outside the single-family set the
 * estimator quotes. Fails open: blank/unknown/missing zoning returns false —
 * never block on missing data.
 */
function isUnsupportedPropertyType(zoning: string | null | undefined): boolean {
  const district = (zoning ?? '').trim().toUpperCase();
  if (district.length === 0) return false;
  return !SINGLE_FAMILY_ZONING.has(district);
}

export function pricingCoverageIssue(
  facts: PricingCoverageFacts,
  bounds: PricingCoverageBounds,
): PricingCoverageIssue | null {
  if (facts.isNonResidential) {
    return 'non-residential';
  }
  if (isUnsupportedPropertyType(facts.zoning)) {
    return 'unsupported-property-type';
  }
  const assessed = Math.round(facts.assessedValue);
  if (
    !Number.isFinite(assessed) ||
    assessed < bounds.minAssessedLandValue ||
    assessed > bounds.maxAssessedLandValue
  ) {
    return 'assessed-value';
  }
  return null;
}
