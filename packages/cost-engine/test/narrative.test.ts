/**
 * Narrative prompt + validation tests (RENO-07, neighbourhood-only rewrite).
 *
 * The AI summary is about the NEIGHBOURHOOD ONLY — why this neighbourhood,
 * Calgary rating, schools, markets, nearby amenities. It must never contain
 * a cost estimate summary, cost table, or engine dollar figures (the report
 * displays the cost breakdown separately), and it must be plain paragraphs
 * with no markdown (the frontend renders it as plain text, so raw `**` /
 * tables / `---` would show literally).
 *
 * Covers:
 *  1. System prompts frame the LLM as a neighbourhood guide with an
 *     explicit cost-estimate ban and a no-markdown rule (prompt-text test).
 *  2. The user prompt carries NO engine figures or assumptions — the model
 *     cannot leak a figure it never saw (byte-identical pin).
 *  3. validateNarrative() rejects any $-figure not from the engine output
 *     (reno fixture + new-build fixture) — the safety net behind the prompt.
 *  4. The prompt builder never interpolates CostParams — only the project
 *     context + CityFacts/CommunityFacts (type-level guarantee: passing
 *     CostData is a compile error).
 *  5. The verbatim footer is appended deterministically.
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

const FACTS: CommunityFacts = {
  community: 'Beltline',
  avgSingleFamilyAssessedValue: 750000,
  assessedHomeCount: 1234,
  avgLotSqft: 5000,
  dataVintage: 'September 2026',
};

function promptOf(input: NarrativePromptInput) {
  return buildNarrativePrompt(input);
}

function inputOf(
  projectType: NarrativePromptInput['projectType'],
  communityFacts?: CommunityFacts,
): NarrativePromptInput {
  return {
    projectType,
    estimate: projectType === 'renovation' ? RENO : NEW_BUILD,
    cityFacts: CITY,
    communityFacts,
  };
}

describe('neighbourhood-only system prompt', () => {
  it('new-build system prompt is byte-identical', () => {
    expect(promptOf(inputOf('new_build', FACTS)).system).toBe(
      [
        "You are Feasly's neighbourhood guide. You write a plain-language neighbourhood guide for a homebuyer considering a new home build in Calgary, Alberta — why this neighbourhood, how it rates within Calgary, schools, markets, and getting around.",
        '',
        'Rules — do not break these:',
        '- The summary is about the NEIGHBOURHOOD ONLY. Do NOT write a cost estimate summary. Do NOT include a cost table, cost breakdown, or any engine dollar figures — the report displays the cost breakdown separately.',
        '- The ONLY dollar figure you may write is the community average assessed value provided below. Copy it exactly, labeled as a City-assessed value (never a market price), or leave it out. Never write any other $-figure, and never invent a dollar figure.',
        '- Never state per-square-foot rates, margin percentages, contingency percentages, or any calibration parameter.',
        '- Never present figures as quotes, guarantees, or appraisals.',
        '- Never claim what a specific builder will charge.',
        '- Do not discuss the specific property, its condition, or any renovation work — this summary is about the neighbourhood only.',
        '- Write in plain paragraphs. Do NOT use markdown formatting — no **bold**, no tables, no --- separators, no | pipes, no headings.',
        '- Write for a homeowner, not a contractor. Be helpful and concrete, never surveillance-toned.',
        '',
        'Neighbourhood — write for a homebuyer choosing this area (Beltline):',
        '- Cover the neighbourhood for a homebuyer: why this area appeals, nearby schools and how they rate, how the area ranks within Calgary, nearby shops and markets, public transport access and nearby amenities, and the average single-family home price.',
        '- Where your knowledge may be stale — school ratings, transit routes, new developments — hedge explicitly ("as of my last update", "worth confirming with the school board") and never state a precise rating, score, or schedule as fact. Never invent school names or ratings.',
        '- The average single-family home price below is a City-assessed value, not a market value — say so. Never restate it approximately: copy the figure exactly or leave it out.',
        '',
        `End every narrative with exactly this sentence: "${NARRATIVE_FOOTER}"`,
      ].join('\n'),
    );
  });

  it('reno system prompt frames a neighbourhood guide for a renovation project', () => {
    const system = promptOf(inputOf('renovation', FACTS)).system;
    expect(system).toContain(
      "homebuyer considering a home renovation in Calgary, Alberta — why this neighbourhood",
    );
    expect(system).toContain('The summary is about the NEIGHBOURHOOD ONLY.');
    expect(system).toContain('Do NOT write a cost estimate summary.');
  });

  it('bans cost estimates, cost tables, and engine dollar figures explicitly', () => {
    for (const projectType of ['new_build', 'renovation'] as const) {
      const system = promptOf(inputOf(projectType, FACTS)).system;
      expect(system).toContain('Do NOT write a cost estimate summary.');
      expect(system).toContain('Do NOT include a cost table, cost breakdown, or any engine dollar figures');
      expect(system).toContain('the report displays the cost breakdown separately.');
      expect(system).toContain('Never write any other $-figure');
    }
  });

  it('requires plain paragraphs with no markdown formatting', () => {
    for (const projectType of ['new_build', 'renovation'] as const) {
      const system = promptOf(inputOf(projectType)).system;
      expect(system).toContain('Write in plain paragraphs.');
      expect(system).toContain('Do NOT use markdown formatting');
      expect(system).toContain('no **bold**, no tables, no --- separators, no | pipes');
    }
  });

  it('no longer frames the LLM as an estimate narrator', () => {
    for (const projectType of ['new_build', 'renovation'] as const) {
      const system = promptOf(inputOf(projectType, FACTS)).system;
      expect(system).not.toContain('estimate narrator');
      expect(system).not.toContain('plain-language summary of a new home build cost estimate');
      expect(system).not.toContain('plain-language summary of a home renovation cost estimate');
    }
  });

  it('no longer carries the reno banned list (the narrative never covers the renovation)', () => {
    const system = promptOf(inputOf('renovation', FACTS)).system;
    expect(system).not.toContain('Do not assert structural conditions');
    expect(system).not.toContain('existing-condition risk uncovered during demolition');
  });

  it('keeps the verbatim footer requirement', () => {
    const system = promptOf(inputOf('new_build', FACTS)).system;
    expect(system).toContain(`End every narrative with exactly this sentence: "${NARRATIVE_FOOTER}"`);
  });

  it('keeps the neighbourhood coverage and hedging rules', () => {
    const system = promptOf(inputOf('new_build', FACTS)).system;
    expect(system).toContain('Neighbourhood — write for a homebuyer');
    expect(system).toContain('nearby schools and how they rate');
    expect(system).toContain('nearby shops and markets');
    expect(system).toContain('public transport access and nearby amenities');
    expect(system).toContain('hedge explicitly');
    expect(system).toContain('Never invent school names or ratings.');
    expect(system).toContain('copy the figure exactly or leave it out');
  });

  it('omits the neighbourhood section when communityFacts are absent', () => {
    const system = promptOf(inputOf('new_build')).system;
    expect(system).not.toContain('Neighbourhood — write for a homebuyer');
    // The neighbourhood-only contract and format rules still apply.
    expect(system).toContain('The summary is about the NEIGHBOURHOOD ONLY.');
    expect(system).toContain('Do NOT use markdown formatting');
  });
});

describe('user prompt (neighbourhood-only: no engine figures)', () => {
  it('is byte-identical', () => {
    expect(promptOf(inputOf('new_build', FACTS)).user).toBe(
      [
        'Project: New home build in Beltline, Calgary',
        '',
        'Neighbourhood: Beltline (City of Calgary assessment data, refreshed September 2026)',
        '- Average single-family home assessed value: $750,000 (City-assessed value, not market value)',
        '- Homes assessed: 1,234',
        '- Average lot size: 5,000 sqft',
      ].join('\n'),
    );
  });

  it('interpolates no engine figures or assumptions', () => {
    for (const projectType of ['new_build', 'renovation'] as const) {
      const user = promptOf(inputOf(projectType, FACTS)).user;
      expect(user).not.toContain('Engine figures');
      expect(user).not.toContain('$40,000');
      expect(user).not.toContain('$1,050,000');
      expect(user).not.toContain('$600,000');
      expect(user).not.toContain('$184,000');
      expect(user).not.toContain('Engine assumptions');
      expect(user).not.toContain('$25,000');
      // The ONLY $-figure the model ever sees is the community average.
      expect(user.match(/\$/g)).toHaveLength(1);
      expect(user).toContain('$750,000');
    }
  });

  it('reno user prompt names the renovation project', () => {
    const user = promptOf(inputOf('renovation', FACTS)).user;
    expect(user).toContain('Project: Home renovation in Beltline, Calgary');
    expect(user).not.toContain('$184,000');
  });

  it('omits the community when unknown', () => {
    const prompt = promptOf({
      projectType: 'new_build',
      estimate: NEW_BUILD,
      cityFacts: { city: 'Calgary', province: 'Alberta' },
    });
    expect(prompt.user).toBe('Project: New home build in Calgary');
  });

  it('omits the price line and exact-copy rule when the average is null', () => {
    const facts: CommunityFacts = { ...FACTS, avgSingleFamilyAssessedValue: null };
    const prompt = promptOf(inputOf('new_build', facts));
    expect(prompt.user).toContain('Neighbourhood: Beltline');
    expect(prompt.user).not.toContain('Average single-family home assessed value');
    expect(prompt.user).not.toContain('$');
    expect(prompt.system).toContain('Neighbourhood — write for a homebuyer');
    expect(prompt.system).not.toContain('copy the figure exactly');
  });

  it('is deterministic across runs', () => {
    const input = inputOf('renovation', FACTS);
    expect(buildNarrativePrompt(input)).toEqual(buildNarrativePrompt(input));
  });
});

describe('narrative validation (safety net)', () => {
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
  const input = inputOf('new_build', FACTS);

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
