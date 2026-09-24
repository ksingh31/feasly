/** Cost-data version stamped on mock estimates. The real engine versions its model. */
export const MOCK_COST_DATA_VERSION = 'mock-2026-09';
/** The fake property every mock flow revolves around. */
export function mockProperty() {
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
export function mockSuggestions() {
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
const MOCK_LOT_SQFT = [4200, 4800, 5200, 5600, 6100];
const MOCK_ZONING = ['R-C1', 'R-C2', 'R-CG'];
const MOCK_ASSESSED = [612400, 748500, 823000, 915000];
const MOCK_YEAR_BUILT = [1951, 1958, 1974, 1983];
function pickFor(addressKey, pool) {
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
const MOCK_PROPERTY_DETAILS = {
    'calgary-1410-14-st-nw': { lotSqft: 4800, zoning: 'R-CG', assessedValue: 748500, yearBuilt: 1958 },
    'calgary-222-7-ave-ne': { lotSqft: 5600, zoning: 'R-C2', assessedValue: 915000, yearBuilt: 1983 },
    'calgary-918-16-ave-nw': { lotSqft: 6100, zoning: 'R-C1', assessedValue: 823000, yearBuilt: 1974 },
    'calgary-4708-22-st-nw': { lotSqft: 5200, zoning: 'R-C2', assessedValue: 612400, yearBuilt: 1951 },
    'calgary-3311-33-ave-sw': { lotSqft: 4200, zoning: 'R-CG', assessedValue: 685000, yearBuilt: 1962 },
    'calgary-101-8-ave-se': { lotSqft: 3900, zoning: 'R-C2', assessedValue: 742000, yearBuilt: 1948 },
    'calgary-2704-24-st-sw': { lotSqft: 5900, zoning: 'R-C1', assessedValue: 879000, yearBuilt: 1967 },
};
export function mockPropertyFor(addressKey) {
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
/** Pre-gate preview: blurred figures only — the type makes leaks a compile error. */
export function mockPreviewEstimate(inputs) {
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
function mockRows() {
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
export function mockEstimate(inputs) {
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
export const MOCK_TIER_FACTORS = {
    standard: 0.92,
    premium: 1.0,
    luxury: 1.12,
};
/** Scales a range, rounding to the nearest thousand (integers, no cents). */
export function scaleRange(range, factor) {
    const round = (n) => Math.round((n * factor) / 1000) * 1000;
    return { low: round(range.low), high: round(range.high) };
}
export function mockLeadResponse(leadId) {
    return { leadId, magicLinkSent: true, expiresInDays: 7 };
}
export function mockVerifySuccess(reportToken, estimateId, leadId) {
    return { valid: true, reportToken, estimateId, leadId };
}
export const MOCK_VERIFY_FAILURE = {
    valid: false,
    reason: 'invalid',
    reissueAllowed: true,
};
const MOCK_NARRATIVE = 'This report estimates the cost to build a new infill home on this lot, based on recent ' +
    'Calgary construction cost data and the City property assessment record. The ranges above ' +
    'reflect the finish tier and size you selected; final costs depend on design choices, ' +
    'site conditions, and the builder you choose.';
/** Post-gate report snapshot. The disclaimer footer comes from config, not here. */
export function mockReport(estimateId, leadId, inputs, narrativeDisclaimer) {
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
export function mockCallbackOk(window) {
    return { ok: true, window };
}
export function mockShareOk(partnerEmail) {
    return { sent: true, sharedTo: partnerEmail };
}
