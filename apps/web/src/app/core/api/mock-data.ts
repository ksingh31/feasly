/**
 * Canned fixture data for the mock API harness (FE0-003).
 *
 * Everything here is obviously fake: one invented Calgary property, fixed
 * estimate ranges, a hard-coded report narrative. This file is the ONE
 * intentional home for literal figures and copy in the mock layer — it is
 * allowlisted from the no-hardcode tripwire, and the conformance specs pin
 * every value it produces. Nothing here is tunable app behavior.
 */
import type {
  AutocompleteSuggestion,
  CallbackResponse,
  CostRange,
  CostRow,
  EstimateInputs,
  EstimateResponse,
  FinishTier,
  GetReportResponse,
  LeadResponse,
  MagicLinkVerifyFailure,
  MagicLinkVerifySuccess,
  PartnerShareResponse,
  PreviewEstimateResponse,
  PropertyRecord,
  RenoEstimateInputs,
  RenoEstimateRequest,
  RenoType,
} from '@feasly/contracts';
import { ESTIMATE_DISCLAIMER } from '@feasly/contracts';

/** Cost-data version stamped on mock estimates. The real engine versions its model. */
export const MOCK_COST_DATA_VERSION = 'mock-2026-09';

/** The fake property every mock flow revolves around. */
export function mockProperty(): PropertyRecord {
  return {
    addressKey: 'calgary-1234-14-st-nw',
    address: '1234 14 St NW, Calgary, AB',
    community: 'Capitol Hill',
    lotSqft: 5200,
    zoning: 'R-C2',
    assessedValue: 685000,
    assessmentYear: 2025,
    yearBuilt: 1962,
    dataAsOf: '2025-07-01',
    stale: false,
  };
}

/** Address pool the mock autocomplete searches. */
export function mockSuggestions(): AutocompleteSuggestion[] {
  return [
    { addressKey: 'calgary-1234-14-st-nw', address: '1234 14 St NW, Calgary, AB', community: 'Capitol Hill' },
    { addressKey: 'calgary-1410-14-st-nw', address: '1410 14 St NW, Calgary, AB', community: 'Capitol Hill' },
    { addressKey: 'calgary-222-7-ave-ne', address: '222 7 Ave NE, Calgary, AB', community: 'Bridgeland' },
    { addressKey: 'calgary-918-16-ave-nw', address: '918 16 Ave NW, Calgary, AB', community: 'Mount Pleasant' },
    { addressKey: 'calgary-4708-22-st-nw', address: '4708 22 St NW, Calgary, AB', community: 'Montgomery' },
    { addressKey: 'calgary-3311-33-ave-sw', address: '3311 33 Ave SW, Calgary, AB', community: 'Killarney/Glengarry' },
    { addressKey: 'calgary-101-8-ave-se', address: '101 8 Ave SE, Calgary, AB', community: 'Inglewood' },
    { addressKey: 'calgary-2704-24-st-sw', address: '2704 24 St SW, Calgary, AB', community: 'Richmond' },
  ];
}

/** Property record for EVERY address the mock autocomplete can suggest.
 *
 * A suggestion the user can pick but the lookup then rejects is a dead end
 * on the front door (bug found by browser QA 2026-09-24: selecting any
 * suggestion other than the single fixture addressKey errored). The primary
 * fixture stays pinned for the conformance specs; every other suggestion
 * derives a stable, obviously-fake record deterministically from its
 * addressKey so values never shift between page loads. */
const MOCK_LOT_SQFT = [4200, 4800, 5200, 5600, 6100] as const;
const MOCK_ZONING = ['R-C1', 'R-C2', 'R-CG'] as const;
const MOCK_ASSESSED = [612400, 748500, 823000, 915000] as const;
const MOCK_YEAR_BUILT = [1951, 1958, 1974, 1983] as const;

function pickFor<T>(addressKey: string, pool: readonly T[]): T {
  let hash = 0;
  for (const ch of addressKey) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return pool[hash % pool.length];
}

/**
 * Explicit mock facts per suggested address so no two addresses share an
 * identical card (hash-picking from small pools collided). Values are
 * plausible inner-city Calgary figures; the real API replaces this file.
 */
const MOCK_PROPERTY_DETAILS: Record<
  string,
  { lotSqft: number; zoning: string; assessedValue: number; yearBuilt: number }
> = {
  'calgary-1410-14-st-nw': { lotSqft: 4800, zoning: 'R-CG', assessedValue: 748500, yearBuilt: 1958 },
  'calgary-222-7-ave-ne': { lotSqft: 5600, zoning: 'R-C2', assessedValue: 915000, yearBuilt: 1983 },
  'calgary-918-16-ave-nw': { lotSqft: 6100, zoning: 'R-C1', assessedValue: 823000, yearBuilt: 1974 },
  'calgary-4708-22-st-nw': { lotSqft: 5200, zoning: 'R-C2', assessedValue: 612400, yearBuilt: 1951 },
  'calgary-3311-33-ave-sw': { lotSqft: 4200, zoning: 'R-CG', assessedValue: 685000, yearBuilt: 1962 },
  'calgary-101-8-ave-se': { lotSqft: 3900, zoning: 'R-C2', assessedValue: 742000, yearBuilt: 1948 },
  'calgary-2704-24-st-sw': { lotSqft: 5900, zoning: 'R-C1', assessedValue: 879000, yearBuilt: 1967 },
};

export function mockPropertyFor(addressKey: string): PropertyRecord | undefined {
  const suggestion = mockSuggestions().find((s) => s.addressKey === addressKey);
  if (!suggestion) {
    return undefined;
  }
  if (addressKey === mockProperty().addressKey) {
    return mockProperty();
  }
  const details = MOCK_PROPERTY_DETAILS[addressKey];
  return {
    addressKey,
    address: suggestion.address,
    community: suggestion.community,
    lotSqft: details?.lotSqft ?? pickFor(addressKey, MOCK_LOT_SQFT),
    zoning: details?.zoning ?? pickFor(addressKey, MOCK_ZONING),
    assessedValue: details?.assessedValue ?? pickFor(addressKey, MOCK_ASSESSED),
    assessmentYear: 2025,
    yearBuilt: details?.yearBuilt ?? pickFor(addressKey, MOCK_YEAR_BUILT),
    dataAsOf: '2025-07-01',
    stale: false,
  };
}

/**
 * Stable estimate identity. The estimate ID is deterministic over the FULL
 * canonical request (property + size + tier + garage + basement + cost data
 * version), so the gate, the analyzing screen, and the report page all resolve
 * the SAME estimate ID for the same inputs instead of minting unrelated
 * estimates — and two different properties can never collide on one ID.
 */
export function stableMockEstimateId(addressKey: string, inputs: EstimateInputs): string {
  const canonical = [
    addressKey,
    inputs.sqft,
    inputs.tier,
    inputs.garage,
    inputs.basement,
    MOCK_COST_DATA_VERSION,
  ].join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `est-mock-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Pre-gate preview: blurred figures only — the type makes leaks a compile error. */
export function mockPreviewEstimate(
  addressKey: string,
  inputs: EstimateInputs,
): PreviewEstimateResponse {
  return {
    estimateId: stableMockEstimateId(addressKey, inputs),
    addressKey,
    inputs,
    figures: {
      build: { blurred: true },
      total: { blurred: true },
      land: { blurred: true },
    },
    rows: [],
    costDataVersion: MOCK_COST_DATA_VERSION,
    createdAt: new Date().toISOString(),
  };
}

/** Canned post-gate figures. Never served pre-gate. */
export function mockEstimateFigures(): Pick<EstimateResponse, 'figures' | 'rows'> {
  return {
    figures: {
      build: { low: 608000, base: 671500, high: 735000 },
      total: { low: 1028000, base: 1091500, high: 1155000 },
      // Fixed City assessed land value — never scaled, never a range.
      land: { value: 420000 },
    },
    rows: mockRows(),
  };
}

/** Post-gate estimate: canned ranges scaled to the selected tier/size. Never served pre-gate. */
export function mockEstimate(
  addressKey: string,
  inputs: EstimateInputs,
  referenceSqft = 2200, // mirrors config wizard.sqftDefault; the service passes the live value
): EstimateResponse {
  const scaled = scaledMockFigures(inputs, referenceSqft);
  return {
    estimateId: stableMockEstimateId(addressKey, inputs),
    addressKey,
    inputs,
    figures: scaled.figures,
    rows: scaled.rows,
    costDataVersion: MOCK_COST_DATA_VERSION,
    createdAt: new Date().toISOString(),
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}

function mockRows(): CostRow[] {
  return [
    { key: 'site', label: 'Site preparation & excavation', range: { low: 38000, base: 42000, high: 46000 } },
    { key: 'foundation', label: 'Foundation & concrete', range: { low: 62000, base: 68000, high: 74000 } },
    { key: 'framing', label: 'Framing & structure', range: { low: 118000, base: 128000, high: 138000 } },
    { key: 'envelope', label: 'Exterior envelope', range: { low: 88000, base: 96000, high: 104000 } },
    { key: 'interior', label: 'Interior finishes', range: { low: 145000, base: 158500, high: 172000 } },
    { key: 'mechanical', label: 'Mechanical & electrical', range: { low: 64000, base: 71000, high: 78000 } },
    { key: 'soft', label: 'Soft costs (permits, design, fees)', range: { low: 45000, base: 51500, high: 58000 } },
    { key: 'contingency', label: 'Contingency', range: { low: 50000, base: 57500, high: 65000 } },
  ];
}

/** Mock tier pricing: relative to premium. Real pricing comes from the cost engine. */
export const MOCK_TIER_FACTORS: Record<FinishTier, number> = {
  standard: 0.92,
  premium: 1.0,
  luxury: 1.12,
};

/** Display names for tiers in mock narrative copy (mirrors wizard copy). */
const TIER_LABELS: Record<FinishTier, string> = {
  standard: 'Standard',
  premium: 'Premium',
  luxury: 'Luxury',
};

/** Scales a range, rounding to the nearest thousand (integers, no cents). */
export function scaleRange(range: CostRange, factor: number): CostRange {
  const round = (n: number) => Math.round((n * factor) / 1000) * 1000;
  return { low: round(range.low), base: round(range.base), high: round(range.high) };
}

/**
 * Applies the selected finish tier and size to the canned base figures.
 * Tier and size factors are ABSOLUTE (relative to the base figures), never
 * relative to a previous revision — so re-running the same inputs always
 * reproduces the same figures, and toggling tiers round-trips exactly.
 * Land is the City assessed value: independent of tier and size, never scaled.
 * Total is recomputed as build + land so the parts always add up.
 */
export function scaledMockFigures(
  inputs: EstimateInputs,
  referenceSqft: number,
): Pick<EstimateResponse, 'figures' | 'rows'> {
  const base = mockEstimateFigures();
  const factor = (MOCK_TIER_FACTORS[inputs.tier] * inputs.sqft) / referenceSqft;
  const build = scaleRange(base.figures.build, factor);
  // Land is the fixed City assessed value: independent of tier and size,
  // never scaled. Total is recomputed as build + land so the parts always
  // add up.
  const land = base.figures.land;
  return {
    figures: {
      build,
      land,
      total: {
        low: build.low + land.value,
        base: build.base + land.value,
        high: build.high + land.value,
      },
    },
    rows: base.rows.map((row) => ({ ...row, range: scaleRange(row.range, factor) })),
  };
}

export function mockLeadResponse(leadId: string): LeadResponse {
  return { leadId, magicLinkSent: true, expiresInDays: 7 };
}

export function mockVerifySuccess(
  reportToken: string,
  estimateId: string,
  leadId: string,
): MagicLinkVerifySuccess {
  return { valid: true, reportToken, estimateId, leadId };
}

export const MOCK_VERIFY_FAILURE: MagicLinkVerifyFailure = {
  valid: false,
  reason: 'invalid',
  reissueAllowed: true,
};

/**
 * Deterministic narrative for the mock report — engine figures only, no
 * LLM-invented numbers. Templated from the actual inputs and figures so the
 * AI-assisted review re-renders whenever the size (or tier) changes.
 */
export function mockNarrative(
  inputs: EstimateInputs,
  figures: Pick<EstimateResponse, 'figures'>['figures'],
  tierLabel: string,
): string {
  const fmt = (n: number): string => `$${n.toLocaleString('en-CA')}`;
  return (
    `At ${inputs.sqft.toLocaleString('en-CA')} sq ft with ${tierLabel.toLowerCase()} finishes, ` +
    `this plan points to an estimated total investment of ${fmt(figures.total.base)}. ` +
    `The ${fmt(figures.land.value)} land value is fixed from the City assessment; ` +
    `the construction portion changes with home size. The planning range reflects ` +
    `early uncertainty in design, site conditions and selections — not a change in the assessed land value.`
  );
}

/** Reno type display labels for mock narratives (mirrors wizard copy). */
const RENO_TYPE_LABELS: Record<RenoType, string> = {
  extensive: 'extensive renovation',
  addition: 'home addition',
  basement: 'basement development',
  combined: 'combined renovation',
};

/** Canned reno breakdown rows (RENO-01). Never served pre-gate. */
function mockRenoRows(): CostRow[] {
  return [
    { key: 'demolition', label: 'Demolition & preparation', range: { low: 8000, base: 10000, high: 12000 } },
    { key: 'structural', label: 'Structural work', range: { low: 15000, base: 18000, high: 21000 } },
    { key: 'envelope', label: 'Exterior & envelope', range: { low: 12000, base: 14500, high: 17000 } },
    { key: 'interior', label: 'Interior finishes', range: { low: 28000, base: 32500, high: 37000 } },
    { key: 'mechanical', label: 'Mechanical & electrical', range: { low: 14000, base: 16500, high: 19000 } },
    { key: 'soft', label: 'Soft costs (permits, design, fees)', range: { low: 9000, base: 11000, high: 13000 } },
    { key: 'contingency', label: 'Contingency', range: { low: 10000, base: 12500, high: 15000 } },
  ];
}

/**
 * Post-gate reno estimate: canned ranges scaled to reno type/size/tier.
 * No land figure — renovations don't touch land. Includes renoInputs,
 * assumptions, and visibility hints per RENO-01.
 */
export function mockRenoEstimate(
  addressKey: string,
  request: RenoEstimateRequest,
): EstimateResponse {
  const base = mockRenoRows();
  // Scale by area (reference: 800 sq ft) and tier
  const factor = (MOCK_TIER_FACTORS[request.tier] * request.renoSqft) / 800;
  const rows = base.map((row) => ({ ...row, range: scaleRange(row.range, factor) }));
  const build = rows.reduce(
    (acc, row) => ({
      low: acc.low + row.range.low,
      base: acc.base + row.range.base,
      high: acc.high + row.range.high,
    }),
    { low: 0, base: 0, high: 0 },
  );
  // For reno, build and total are the same (no land)
  const total = { ...build };
  
  const inputs: EstimateInputs = {
    sqft: request.renoSqft,
    tier: request.tier,
    garage: 'none',
    basement: 'unfinished',
  };
  
  return {
    estimateId: stableMockEstimateId(addressKey, inputs),
    addressKey,
    inputs,
    figures: {
      build,
      total,
      // Land is not applicable for renovations — use a zero fixed figure
      // (the visibility hint marks it not_applicable; the UI hides the row)
      land: { value: 0 },
    },
    rows,
    costDataVersion: MOCK_COST_DATA_VERSION,
    createdAt: new Date().toISOString(),
    projectType: 'renovation',
    renoInputs: {
      projectType: 'renovation',
      renoType: request.renoType,
      renoSqft: request.renoSqft,
      tier: request.tier,
      underpinning: request.underpinning,
    },
    assumptions: [
      `Scope covers ${request.renoSqft.toLocaleString('en-CA')} sq ft of ${RENO_TYPE_LABELS[request.renoType]}.`,
      request.underpinning
        ? 'Includes underpinning for the basement foundation.'
        : 'No structural underpinning included.',
      'Permit and contingency allowances are estimates — confirm with the City of Calgary and your builder.',
    ],
    visibility: {
      land: 'not_applicable',
      build: 'visible',
      total: 'visible',
    },
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}

/**
 * Deterministic narrative for a reno report — engine figures only.
 */
export function mockRenoNarrative(
  renoInputs: RenoEstimateInputs,
  figures: Pick<EstimateResponse, 'figures'>['figures'],
  tierLabel: string,
): string {
  const fmt = (n: number): string => `$${n.toLocaleString('en-CA')}`;
  return (
    `This ${RENO_TYPE_LABELS[renoInputs.renoType]} covering ` +
    `${renoInputs.renoSqft.toLocaleString('en-CA')} sq ft with ${tierLabel.toLowerCase()} finishes ` +
    `points to an estimated investment of ${fmt(figures.total.base)}. ` +
    `The planning range reflects early uncertainty in scope, site conditions and selections.`
  );
}

/** Post-gate report snapshot. The disclaimer footer comes from config, not here. */
export function mockReport(
  estimateId: string,
  leadId: string,
  inputs: EstimateInputs,
  narrativeDisclaimer: string,
  referenceSqft = 2200, // mirrors config wizard.sqftDefault; the service passes the live value
): GetReportResponse {
  const scaled = scaledMockFigures(inputs, referenceSqft);
  return {
    snapshotId: `snap-mock-${estimateId}-1`,
    estimateId,
    leadId,
    inputs,
    buildRange: scaled.figures.build,
    totalRange: scaled.figures.total,
    landValue: scaled.figures.land,
    rows: scaled.rows,
    narrative: `${mockNarrative(inputs, scaled.figures, TIER_LABELS[inputs.tier])} ${narrativeDisclaimer}`,
    preparedAt: new Date().toISOString(),
    version: 1,
  };
}

/**
 * Mock reno report: no land value, includes renoInputs and assumptions.
 * Used when the estimate was created via mockRenoEstimate (RENO-04).
 */
export function mockRenoReport(
  estimateId: string,
  leadId: string,
  renoInputs: RenoEstimateInputs,
  narrativeDisclaimer: string,
): GetReportResponse {
  const request: RenoEstimateRequest = {
    projectType: 'renovation',
    addressKey: estimateId, // not used for figures
    renoType: renoInputs.renoType,
    renoSqft: renoInputs.renoSqft,
    tier: renoInputs.tier,
    underpinning: renoInputs.underpinning,
  };
  const estimate = mockRenoEstimate(estimateId, request);
  const inputs: EstimateInputs = {
    sqft: renoInputs.renoSqft,
    tier: renoInputs.tier,
    garage: 'none',
    basement: 'unfinished',
  };
  return {
    snapshotId: `snap-mock-${estimateId}-1`,
    estimateId,
    leadId,
    inputs,
    buildRange: estimate.figures.build,
    totalRange: estimate.figures.total,
    landValue: { value: 0 }, // not applicable for reno
    rows: estimate.rows,
    narrative: `${mockRenoNarrative(renoInputs, estimate.figures, TIER_LABELS[renoInputs.tier])} ${narrativeDisclaimer}`,
    preparedAt: new Date().toISOString(),
    version: 1,
    projectType: 'renovation',
    renoInputs,
    assumptions: estimate.assumptions,
  };
}

export function mockCallbackOk(window: 'morning' | 'afternoon' | 'evening'): CallbackResponse {
  return { ok: true, window };
}

export function mockShareOk(partnerEmail: string): PartnerShareResponse {
  return { sent: true, sharedTo: partnerEmail };
}
