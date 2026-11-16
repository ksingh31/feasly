/**
 * Community narratives (#759): the monthly per-community prompt, its
 * validator, and the deterministic estimate-summary template.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCommunityNarrativePrompt,
  buildEstimateSummary,
  buildNarrativePrompt,
  validateCommunityNarrative,
  validateNarrative,
  type CommunityFacts,
  type EstimateOutput,
} from '../src/narrative';

const FACTS: CommunityFacts = {
  community: 'Beltline',
  avgSingleFamilyAssessedValue: 750000,
  assessedHomeCount: 1234,
  avgLotSqft: 5000,
  dataVintage: 'September 2026',
};

const NEW_BUILD: EstimateOutput = {
  costDataVersion: 'test-v1',
  calibrated: true,
  rows: [],
  totals: {
    build: { low: 400_000, base: 450_000, high: 500_000 },
    land: { value: 600_000 },
    total: { low: 1_000_000, base: 1_050_000, high: 1_100_000 },
  },
};

const RENO: EstimateOutput = {
  costDataVersion: 'test-v1',
  calibrated: false,
  rows: [],
  total: { low: 184_000, base: 230_000, high: 288_000 },
  assumptions: [],
};

describe('buildCommunityNarrativePrompt', () => {
  it('matches the per-estimate neighbourhood prompt for the same community', () => {
    const perEstimate = buildNarrativePrompt({
      projectType: 'new_build',
      estimate: NEW_BUILD,
      cityFacts: { city: 'Calgary', province: 'Alberta', community: 'Beltline' },
      communityFacts: FACTS,
    });
    expect(buildCommunityNarrativePrompt(FACTS)).toEqual(perEstimate);
  });

  it('carries the community average and no engine figures', () => {
    const prompt = buildCommunityNarrativePrompt(FACTS);
    expect(prompt.user).toContain('$750,000');
    expect(prompt.user).not.toContain('$450,000');
    expect(prompt.system).toContain('Beltline');
  });
});

describe('validateCommunityNarrative', () => {
  it('accepts the community average copied exactly', () => {
    expect(
      validateCommunityNarrative('Homes average $750,000 (City-assessed).', FACTS).ok,
    ).toBe(true);
  });

  it('rejects any other figure', () => {
    const result = validateCommunityNarrative('Builds run about $450,000.', FACTS);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('$450,000');
  });

  it('rejects every figure when the community has no average', () => {
    const noAvg = { ...FACTS, avgSingleFamilyAssessedValue: null };
    expect(validateCommunityNarrative('About $750,000.', noAvg).ok).toBe(false);
    expect(validateCommunityNarrative('A leafy area.', noAvg).ok).toBe(true);
  });
});

describe('buildEstimateSummary', () => {
  it('fills size, finish, and the build range from engine output', () => {
    const text = buildEstimateSummary(NEW_BUILD, { sqft: 2200, finishTier: 'standard' });
    expect(text).toBe(
      'For this 2,200 sq ft new home with a standard finish, our cost model puts ' +
        'the build cost between $400,000 and $500,000, with a typical figure of $450,000.',
    );
  });

  it('omits size and finish when unknown', () => {
    expect(buildEstimateSummary(NEW_BUILD)).toBe(
      'For this new home, our cost model puts the build cost between $400,000 ' +
        'and $500,000, with a typical figure of $450,000.',
    );
  });

  it('describes renovations from the reno total', () => {
    expect(buildEstimateSummary(RENO)).toContain('between $184,000 and $288,000');
  });

  it('always passes the engine-figure validator', () => {
    for (const estimate of [NEW_BUILD, RENO]) {
      expect(validateNarrative(buildEstimateSummary(estimate, { sqft: 1800 }), estimate).ok).toBe(true);
    }
  });
});
