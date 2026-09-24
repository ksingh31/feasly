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
} from '@feasly/contracts';

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

export function mockPropertyFor(addressKey: string): PropertyRecord | undefined {
  const suggestion = mockSuggestions().find((s) => s.addressKey === addressKey);
  if (!suggestion) {
    return undefined;
  }
  if (addressKey === mockProperty().addressKey) {
    return mockProperty();
  }
  return {
    addressKey,
    address: suggestion.address,
    community: suggestion.community,
    lotSqft: pickFor(addressKey, MOCK_LOT_SQFT),
    zoning: pickFor(addressKey, MOCK_ZONING),
    assessedValue: pickFor(addressKey, MOCK_ASSESSED),
    assessmentYear: 2025,
    yearBuilt: pickFor(addressKey, MOCK_YEAR_BUILT),
    dataAsOf: '2025-07-01',
    stale: false,
  };
}

/** Pre-gate preview: blurred figures only — the type makes leaks a compile error. */
export function mockPreviewEstimate(inputs: EstimateInputs): PreviewEstimateResponse {
  return {
    estimateId: `est-mock-${inputs.sqft}-${inputs.tier}`,
    addressKey: mockProperty().addressKey,
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

function mockRows(): CostRow[] {
  return [
    { key: 'site', label: 'Site preparation & excavation', range: { low: 38000, high: 46000 } },
    { key: 'foundation', label: 'Foundation & concrete', range: { low: 62000, high: 74000 } },
    { key: 'framing', label: 'Framing & structure', range: { low: 118000, high: 138000 } },
    { key: 'envelope', label: 'Exterior envelope', range: { low: 88000, high: 104000 } },
    { key: 'interior', label: 'Interior finishes', range: { low: 145000, high: 172000 } },
    { key: 'mechanical', label: 'Mechanical & electrical', range: { low: 64000, high: 78000 } },
  ];
}

/** Post-gate estimate: canned ranges. Never served pre-gate. */
export function mockEstimate(inputs: EstimateInputs): EstimateResponse {
  return {
    estimateId: `est-mock-${inputs.sqft}-${inputs.tier}`,
    addressKey: mockProperty().addressKey,
    inputs,
    figures: {
      build: { low: 485000, high: 560000 },
      total: { low: 880000, high: 1005000 },
      land: { low: 395000, high: 445000 },
    },
    rows: mockRows(),
    costDataVersion: MOCK_COST_DATA_VERSION,
    createdAt: new Date().toISOString(),
  };
}

/** Mock tier pricing: relative to premium. Real pricing comes from the cost engine. */
export const MOCK_TIER_FACTORS: Record<FinishTier, number> = {
  standard: 0.92,
  premium: 1.0,
  luxury: 1.12,
};

/** Scales a range, rounding to the nearest thousand (integers, no cents). */
export function scaleRange(range: CostRange, factor: number): CostRange {
  const round = (n: number) => Math.round((n * factor) / 1000) * 1000;
  return { low: round(range.low), high: round(range.high) };
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

const MOCK_NARRATIVE =
  'This report estimates the cost to build a new infill home on this lot, based on recent ' +
  'Calgary construction cost data and the City property assessment record. The ranges above ' +
  'reflect the finish tier and size you selected; final costs depend on design choices, ' +
  'site conditions, and the builder you choose.';

/** Post-gate report snapshot. The disclaimer footer comes from config, not here. */
export function mockReport(
  estimateId: string,
  leadId: string,
  inputs: EstimateInputs,
  narrativeDisclaimer: string,
): GetReportResponse {
  const estimate = mockEstimate(inputs);
  return {
    snapshotId: `snap-mock-${estimateId}-1`,
    estimateId,
    leadId,
    inputs,
    buildRange: estimate.figures.build,
    totalRange: estimate.figures.total,
    landRange: estimate.figures.land,
    rows: estimate.rows,
    narrative: `${MOCK_NARRATIVE} ${narrativeDisclaimer}`,
    preparedAt: new Date().toISOString(),
    version: 1,
  };
}

export function mockCallbackOk(window: 'morning' | 'afternoon' | 'evening'): CallbackResponse {
  return { ok: true, window };
}

export function mockShareOk(partnerEmail: string): PartnerShareResponse {
  return { sent: true, sharedTo: partnerEmail };
}
