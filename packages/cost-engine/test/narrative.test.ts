/**
 * Narrative prompt + validation tests (RENO-07).
 *
 * Covers the story's acceptance criteria:
 *  1. Reno prompts carry the reno banned-list additions as explicit
 *     "do not" instructions (prompt-text test).
 *  2. validateNarrative() rejects any $-figure not from the engine output
 *     (reno fixture + new-build fixture).
 *  3. The prompt builder never interpolates CostParams — only the engine
 *     output + CityFacts (type-level guarantee: passing CostData is a
 *     compile error).
 *  4. New-build prompts are byte-identical (regression pin — the reno branch
 *     must not drift the existing flow).
 *
 * NOTE: no narrative prompt builder existed before this story, so the
 * "byte-identical" baseline is established here and pinned going forward.
 */
import { describe, expect, it } from 'vitest';
import {
  allowedNarrativeFigures,
  buildNarrativePrompt,
  ensureNarrativeFooter,
  NARRATIVE_FOOTER,
  validateNarrative,
  type CommunityFacts,
  type EstimateOutput,
  type NarrativePromptInput,
} from '../src/narrative';
import type { CostData } from '../src/types';
import { PLACEHOLDER_COST_DATA } from '../src/cost-data';

const CITY = { city: 'Calgary', province: 'Alberta', community: 'Beltline' } as const;

const NEW_BUILD: EstimateOutput = {
  costDataVersion: 'test-v1',
  calibrated: true,
  rows: [
    {
      key: 'hard.foundation',
      label: 'Foundation',
      formula: 'buildSqft × hardCosts.foundation.rates[tier]',
      range: { low: 40_000, base: 45_000, high: 50_000 },
    },
  ],
  totals: {
    build: { low: 400_000, base: 450_000, high: 500_000 },
    land: { value: 600_000 },
    total: { low: 1_000_000, base: 1_050_000, high: 1_100_000 },
  },
};

const RENO: EstimateOutput = {
  costDataVersion: 'test-v1',
  calibrated: false,
  rows: [
    {
      key: 'reno.extensive',
      label: 'Extensive renovation',
      formula: 'renoSqft × reno.components.extensive.rates[tier]',
      range: { low: 184_000, base: 230_000, high: 288_000 },
    },
  ],
  total: { low: 184_000, base: 230_000, high: 288_000 },
  assumptions: [
    'Reno rates are draft placeholders until calibrated.',
    'Underpinning allowance up to $25,000 where required.',
  ],
};

function promptOf(input: NarrativePromptInput) {
  return buildNarrativePrompt(input);
}

describe('reno prompt banned list (AC1)', () => {
  const system = promptOf({ projectType: 'renovation', estimate: RENO, cityFacts: CITY }).system;

  it.each([
    'Do not assert structural conditions of the existing home (foundation, framing, soil, drainage) beyond the facts given.',
    'Do not assert that the existing home complies with current building code, or guarantee that permits will be approved.',
    "Do not claim the renovation will increase the home's market value by a specific dollar amount.",
    'Speak to renovation realities: existing-condition risk uncovered during demolition, permit timelines, and what it is like to live through construction.',
  ])('includes the explicit instruction: %s', (instruction) => {
    expect(system).toContain(`- ${instruction}`);
  });

  it('frames the project as a renovation', () => {
    expect(system).toContain('home renovation cost estimate');
  });

  it('does not leak the reno rules into the new-build prompt', () => {
    const newBuild = promptOf({ projectType: 'new_build', estimate: NEW_BUILD, cityFacts: CITY }).system;
    expect(newBuild).not.toContain('Do not assert structural conditions');
    expect(newBuild).not.toContain('market value');
    expect(newBuild).toContain('new home build cost estimate');
  });
});

describe('new-build prompt regression pin (AC4)', () => {
  const prompt = promptOf({ projectType: 'new_build', estimate: NEW_BUILD, cityFacts: CITY });

  it('system prompt is byte-identical', () => {
    expect(prompt.system).toBe(
      [
        "You are Feasly's estimate narrator. You write the plain-language summary of a new home build cost estimate for a homeowner in Calgary, Alberta.",
        '',
        'Rules — do not break these:',
        '- Never invent a dollar figure. Every $ figure you write must be one of the engine figures provided, copied exactly.',
        '- Never state per-square-foot rates, margin percentages, contingency percentages, or any calibration parameter.',
        '- Never present figures as quotes, guarantees, or appraisals. They are planning ranges from current cost data.',
        '- Never claim what a specific builder will charge.',
        '- Write for a homeowner, not a contractor. Be helpful and concrete, never surveillance-toned.',
        '',
        `End every narrative with exactly this sentence: "${NARRATIVE_FOOTER}"`,
      ].join('\n'),
    );
  });

  it('user prompt is byte-identical', () => {
    expect(prompt.user).toBe(
      [
        'Project: New home build in Beltline, Calgary',
        '',
        'Engine figures — the ONLY dollar figures you may reference:',
        '- Foundation: $40,000 – $45,000 – $50,000 (low – base – high)',
        '- Build total: $400,000 – $450,000 – $500,000 (low – base – high)',
        '- Land (assessed value, fixed): $600,000',
        '- Project total: $1,000,000 – $1,050,000 – $1,100,000 (low – base – high)',
      ].join('\n'),
    );
  });

  it('reno user prompt lists reno figures and assumptions', () => {
    const reno = promptOf({ projectType: 'renovation', estimate: RENO, cityFacts: CITY });
    expect(reno.user).toContain('Project: Home renovation in Beltline, Calgary');
    expect(reno.user).toContain('- Extensive renovation: $184,000 – $230,000 – $288,000 (low – base – high)');
    expect(reno.user).toContain('- Renovation total: $184,000 – $230,000 – $288,000 (low – base – high)');
    expect(reno.user).toContain('- Reno rates are draft placeholders until calibrated.');
  });

  it('omits the community when unknown', () => {
    const prompt = promptOf({
      projectType: 'new_build',
      estimate: NEW_BUILD,
      cityFacts: { city: 'Calgary', province: 'Alberta' },
    });
    expect(prompt.user).toContain('Project: New home build in Calgary');
  });

  it('is deterministic across runs', () => {
    const input: NarrativePromptInput = { projectType: 'renovation', estimate: RENO, cityFacts: CITY };
    expect(buildNarrativePrompt(input)).toEqual(buildNarrativePrompt(input));
  });
});

describe('narrative validation (AC2)', () => {
  it('passes a reno narrative using only engine figures + the footer', () => {
    const narrative = [
      'Your extensive renovation is estimated at $230,000, within a range of $184,000 to $288,000.',
      NARRATIVE_FOOTER,
    ].join(' ');
    expect(validateNarrative(narrative, RENO)).toEqual({ ok: true, violations: [] });
  });

  it('passes a new-build narrative using only engine figures + the footer', () => {
    const narrative = `The project total is $1,050,000 on assessed land of $600,000. ${NARRATIVE_FOOTER}`;
    expect(validateNarrative(narrative, NEW_BUILD)).toEqual({ ok: true, violations: [] });
  });

  it('fails a reno narrative with an invented $-figure', () => {
    const narrative = `Expect to pay around $350,000 all-in. ${NARRATIVE_FOOTER}`;
    const result = validateNarrative(narrative, RENO);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('$350,000');
  });

  it('fails a new-build narrative with an invented $-figure', () => {
    const narrative = `Roughly $999,999 should cover it. ${NARRATIVE_FOOTER}`;
    const result = validateNarrative(narrative, NEW_BUILD);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('$999,999');
  });

  it('allows $-figures quoted inside engine assumptions', () => {
    const narrative = `Underpinning allowance up to $25,000 where required. ${NARRATIVE_FOOTER}`;
    expect(validateNarrative(narrative, RENO).ok).toBe(true);
  });

  it('passes a narrative without the footer — the worker appends it deterministically', () => {
    const narrative = 'Your extensive renovation is estimated at $230,000.';
    expect(validateNarrative(narrative, RENO)).toEqual({ ok: true, violations: [] });
  });

  it('reports every invented figure, not just the first', () => {
    const narrative = `$111,111 for permits and $222,222 for design. ${NARRATIVE_FOOTER}`;
    const result = validateNarrative(narrative, NEW_BUILD);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
  });
});

describe('ensureNarrativeFooter', () => {
  it('appends the verbatim footer as its own paragraph when missing', () => {
    const result = ensureNarrativeFooter('Your build is estimated at $450,000.');
    expect(result).toBe(
      `Your build is estimated at $450,000.\n\n${NARRATIVE_FOOTER}`,
    );
  });

  it('trims trailing whitespace before appending', () => {
    const result = ensureNarrativeFooter('Summary text.  \n');
    expect(result).toBe(`Summary text.\n\n${NARRATIVE_FOOTER}`);
  });

  it('leaves text unchanged when the model already emitted the footer', () => {
    const text = `Summary text. ${NARRATIVE_FOOTER}`;
    expect(ensureNarrativeFooter(text)).toBe(text);
  });

  it('appended footer passes validation', () => {
    const text = ensureNarrativeFooter('Roughly $999,999 should cover it.');
    const result = validateNarrative(text, NEW_BUILD);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('$999,999');
  });
});

describe('allowed figures', () => {
  it('collects every engine figure exactly once', () => {
    const figures = allowedNarrativeFigures(RENO);
    expect(figures).toContain('$184,000');
    expect(figures).toContain('$230,000');
    expect(figures).toContain('$288,000');
    expect(figures).toContain('$25,000');
    expect(new Set(figures).size).toBe(figures.length);
  });

  it('includes the fixed land value for new-build estimates', () => {
    expect(allowedNarrativeFigures(NEW_BUILD)).toContain('$600,000');
  });
});

describe('type-level guarantee: no CostParams in prompts (AC3)', () => {
  it('rejects CostData at compile time', () => {
    const costData: CostData = PLACEHOLDER_COST_DATA;
    // Compile-time assertion only: the @ts-expect-error lines below must
    // never execute at runtime, so they sit behind a never-true branch.
    // If the parameter types ever widen to accept CostData, tsc fails here.
    if (false as boolean) {
      // @ts-expect-error — calibration numbers are not a valid prompt input.
      buildNarrativePrompt(costData);
      // @ts-expect-error — CostData is not an engine output either.
      validateNarrative('narrative', costData);
    }
    expect(true).toBe(true);
  });
});

describe('neighbourhood section (communityFacts)', () => {
  const FACTS: CommunityFacts = {
    community: 'Beltline',
    avgSingleFamilyAssessedValue: 750000,
    assessedHomeCount: 1234,
    avgLotSqft: 5000,
    dataVintage: 'September 2026',
  };
  const input: NarrativePromptInput = {
    projectType: 'new_build',
    estimate: NEW_BUILD,
    cityFacts: CITY,
    communityFacts: FACTS,
  };

  it('adds the neighbourhood stats section to the user prompt', () => {
    const prompt = buildNarrativePrompt(input);
    expect(prompt.user).toContain(
      'Neighbourhood: Beltline (City of Calgary assessment data, refreshed September 2026)',
    );
    expect(prompt.user).toContain(
      '- Average single-family home assessed value: $750,000 (City-assessed value, not market value)',
    );
    expect(prompt.user).toContain('- Homes assessed: 1,234');
    expect(prompt.user).toContain('- Average lot size: 5,000 sqft');
    expect(prompt.user).toContain(
      'Engine figures — the ONLY dollar figures you may reference, plus the community average above:',
    );
  });

  it('instructs the LLM to cover schools, transit, and area character — hedged', () => {
    const prompt = buildNarrativePrompt(input);
    expect(prompt.system).toContain('Neighbourhood — write for a homebuyer');
    expect(prompt.system).toContain('nearby schools and how they rate');
    expect(prompt.system).toContain("the area's character and how it ranks within Calgary");
    expect(prompt.system).toContain('public transport access');
    expect(prompt.system).toContain('hedge explicitly');
    expect(prompt.system).toContain('Never invent school names or ratings.');
    expect(prompt.system).toContain('copy the figure exactly or leave it out');
  });

  it('omits the neighbourhood section when communityFacts are absent', () => {
    const prompt = buildNarrativePrompt({
      projectType: 'new_build',
      estimate: NEW_BUILD,
      cityFacts: CITY,
    });
    expect(prompt.user).not.toContain('Neighbourhood:');
    expect(prompt.user).toContain(
      'Engine figures — the ONLY dollar figures you may reference:',
    );
    expect(prompt.system).not.toContain('Neighbourhood — write for a homebuyer');
  });

  it('omits the price line and exact-copy rule when the average is null', () => {
    const facts: CommunityFacts = { ...FACTS, avgSingleFamilyAssessedValue: null };
    const prompt = buildNarrativePrompt({
      projectType: 'new_build',
      estimate: NEW_BUILD,
      cityFacts: CITY,
      communityFacts: facts,
    });
    expect(prompt.user).toContain('Neighbourhood: Beltline');
    expect(prompt.user).not.toContain('Average single-family home assessed value');
    expect(prompt.system).toContain('Neighbourhood — write for a homebuyer');
    expect(prompt.system).not.toContain('copy the figure exactly');
  });

  it('validator allows the community average figure when provided', () => {
    const narrative = [
      'Beltline averages $750,000 for a single-family home (City-assessed value, not market value).',
      NARRATIVE_FOOTER,
    ].join(' ');
    expect(validateNarrative(narrative, NEW_BUILD, FACTS)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it('validator still rejects other invented figures when communityFacts are present', () => {
    const narrative = `Beltline averages $750,000. Expect to pay $999,999. ${NARRATIVE_FOOTER}`;
    const result = validateNarrative(narrative, NEW_BUILD, FACTS);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('$999,999');
  });

  it('validator rejects the community average when communityFacts are absent', () => {
    const narrative = `Beltline averages $750,000. ${NARRATIVE_FOOTER}`;
    const result = validateNarrative(narrative, NEW_BUILD);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('$750,000');
  });
});
