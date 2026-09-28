/**
 * LLM narrative prompt construction + narrative validation (RENO-07).
 *
 * The cost engine is deterministic math; the LLM only writes the
 * neighbourhood guide around the property's community — it never sees or
 * produces engine dollar figures. This module is the boundary between the
 * two:
 *
 * - `buildNarrativePrompt()` assembles the prompt the narrative worker sends
 *   to the LLM. It interpolates ONLY the project context, CityFacts, and
 *   CommunityFacts. Engine figures and assumptions are deliberately NOT in
 *   the prompt: the narrative is about the neighbourhood only (the report
 *   displays the cost breakdown separately), so the model cannot leak a
 *   figure it never saw. Calibration numbers (CostData / CostParams) can
 *   never reach the prompt: the parameter type makes passing them a
 *   compile error, asserted by narrative.test.ts.
 * - `validateNarrative()` rejects any narrative containing a $-figure that
 *   did not come from the engine output (or the community average below).
 *   It is the safety net for the one sanctioned figure and against invented
 *   numbers — a model that disobeys the neighbourhood-only rule and invents
 *   figures fails validation and the service falls back to the static guide.
 * - `ensureNarrativeFooter()` appends the verbatim compliance footer when the
 *   model omitted it — compliance text is applied deterministically, never
 *   left to model obedience (a model upgrade once dropped the footer and
 *   failed validation on an otherwise good narrative).
 *
 * CommunityFacts carries published City of Calgary assessment aggregates —
 * the one sanctioned $-figure the LLM may echo (copied exactly, labeled as
 * City-assessed rather than market value). It is a published stat, not an
 * engine computation, and never a calibration number.
 *
 * The narrative is rendered as plain text on the frontend
 * (`<p class="narrative">{{ narrative() }}</p>` — no markdown rendering),
 * so the system prompt instructs plain paragraphs with no markdown
 * formatting: raw `**`, tables, or `---` separators would show literally.
 *
 * Pure string building: no I/O, no clock, no env (covered by the
 * engine-purity scan).
 */
import type {
  EstimateResult,
  RangedAmount,
  RenoEstimateResult,
} from './types';

/** Which estimate the narrative describes. */
export type NarrativeProjectType = 'new_build' | 'renovation';

/** Union of engine outputs the narrative worker may narrate. */
export type EstimateOutput = EstimateResult | RenoEstimateResult;

/**
 * City facts the prompt may reference. Place facts only (city, community) —
 * never prices. Dollar-free by construction.
 */
export interface CityFacts {
  /** e.g. "Calgary". */
  readonly city: string;
  /** e.g. "Alberta". */
  readonly province: string;
  /** e.g. "Beltline". Optional — omitted when unknown. */
  readonly community?: string;
}

/**
 * Community facts from City of Calgary assessment aggregates (Socrata).
 *
 * Everything here is a published stat, safe for the LLM to echo — the ONLY
 * $-figure the narrative may repeat is `avgSingleFamilyAssessedValue`,
 * copied exactly and labeled City-assessed (never market value). No engine
 * calibration numbers may ever be added to this type.
 */
export interface CommunityFacts {
  /** e.g. "Beltline". */
  readonly community: string;
  /**
   * Average single-family (R110) City-assessed value, whole CAD dollars.
   * Null when the stats row is missing — the prompt then omits the price.
   */
  readonly avgSingleFamilyAssessedValue: number | null;
  /** Number of assessed homes behind the average. Null when unavailable. */
  readonly assessedHomeCount: number | null;
  /** Average lot size in sqft. Null when unavailable. */
  readonly avgLotSqft: number | null;
  /** Aggregate vintage for hedging, e.g. "September 2026". Null when unknown. */
  readonly dataVintage: string | null;
}

/**
 * The ONLY input `buildNarrativePrompt` accepts. CostData / CostParams is
 * not assignable to this type, so calibration numbers cannot be
 * interpolated into a prompt — a type-level guarantee (AC3). The estimate
 * is carried for `validateNarrative()` (the $-figure safety net); its
 * figures are never interpolated into the prompt itself.
 */
export interface NarrativePromptInput {
  readonly projectType: NarrativeProjectType;
  readonly estimate: EstimateOutput;
  readonly cityFacts: CityFacts;
  /** Optional — omitted when the community (or its stats) is unknown. */
  readonly communityFacts?: CommunityFacts;
}

/** The assembled prompt: system framing + user context. */
export interface NarrativePrompt {
  readonly system: string;
  readonly user: string;
}

/** Matches a $-figure token: "$1,050,000", "$25000", "$99.99". Never swallows trailing commas. */
const FIGURE_PATTERN = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g;

/** Verbatim footer on every generated narrative (pinned by test). */
export const NARRATIVE_FOOTER =
  'Dollar figures are calculated deterministically from our cost model — not generated by AI.';

/**
 * Ensure the verbatim compliance footer is present. Returns the text
 * unchanged when the model already emitted it; otherwise appends it as its
 * own paragraph. The narrative worker applies this to every provider
 * output before validation — the footer must appear on every narrative,
 * so it is enforced deterministically rather than required from the model.
 */
export function ensureNarrativeFooter(text: string): string {
  if (text.includes(NARRATIVE_FOOTER)) return text;
  return `${text.trimEnd()}\n\n${NARRATIVE_FOOTER}`;
}

/** Format a whole-dollar CAD amount: 1050000 -> "$1,050,000". */
function formatCadWhole(dollars: number): string {
  return '$' + formatWhole(dollars);
}

/** Format a plain whole number with thousands separators (non-dollar stats). */
function formatWhole(n: number): string {
  const rounded = Math.round(n);
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Format a closed range the same way everywhere (prompt and validator). */
function formatRange(range: RangedAmount): string {
  return `${formatCadWhole(range.low)} – ${formatCadWhole(range.base)} – ${formatCadWhole(range.high)}`;
}

/**
 * Engine-authored assumptions — the qualitative engine→narrative channel.
 * New-build outputs carry none; reno outputs carry the RENO-01 list.
 */
function assumptionsOf(estimate: EstimateOutput): readonly string[] {
  return 'assumptions' in estimate ? estimate.assumptions : [];
}

/**
 * Every $-figure the engine produced, as exact strings. The validator
 * permits exactly these (plus figures quoted inside assumptions).
 */
export function allowedNarrativeFigures(estimate: EstimateOutput): readonly string[] {
  const seen = new Set<string>();
  const add = (figure: string): void => {
    if (!seen.has(figure)) seen.add(figure);
  };
  const addRange = (range: RangedAmount): void => {
    add(formatCadWhole(range.low));
    add(formatCadWhole(range.base));
    add(formatCadWhole(range.high));
  };
  for (const row of estimate.rows) addRange(row.range);
  if ('totals' in estimate) {
    addRange(estimate.totals.build);
    add(formatCadWhole(estimate.totals.land.value));
    addRange(estimate.totals.total);
  } else {
    addRange(estimate.total);
  }
  for (const assumption of assumptionsOf(estimate)) {
    for (const figure of assumption.match(FIGURE_PATTERN) ?? []) {
      add(figure);
    }
  }
  return [...seen];
}

/** Rules every narrative must obey — shared by new-build and reno prompts. */
const SHARED_RULES: readonly string[] = [
  'The summary is about the NEIGHBOURHOOD ONLY. Do NOT write a cost estimate summary. Do NOT include a cost table, cost breakdown, or any engine dollar figures — the report displays the cost breakdown separately.',
  'The ONLY dollar figure you may write is the community average assessed value provided below. Copy it exactly, labeled as a City-assessed value (never a market price), or leave it out. Never write any other $-figure, and never invent a dollar figure.',
  'Never state per-square-foot rates, margin percentages, contingency percentages, or any calibration parameter.',
  'Never present figures as quotes, guarantees, or appraisals.',
  'Never claim what a specific builder will charge.',
  'Do not discuss the specific property, its condition, or any renovation work — this summary is about the neighbourhood only.',
  'Write in plain paragraphs. Do NOT use markdown formatting — no **bold**, no tables, no --- separators, no | pipes, no headings.',
  'Write for a homeowner, not a contractor. Be helpful and concrete, never surveillance-toned.',
];

function renderRules(rules: readonly string[]): string {
  return rules.map((rule) => `- ${rule}`).join('\n');
}

function buildSystemPrompt(
  projectType: NarrativeProjectType,
  cityFacts: CityFacts,
  communityFacts?: CommunityFacts,
): string {
  const place = `${cityFacts.city}, ${cityFacts.province}`;
  const project =
    projectType === 'renovation' ? 'a home renovation' : 'a new home build';
  const sections = [
    `You are Feasly's neighbourhood guide. You write a plain-language neighbourhood guide for a homebuyer considering ${project} in ${place} — why this neighbourhood, how it rates within Calgary, schools, markets, and getting around.`,
    '',
    'Rules — do not break these:',
    renderRules(SHARED_RULES),
  ];
  if (communityFacts) {
    sections.push(
      '',
      `Neighbourhood — write for a homebuyer choosing this area (${communityFacts.community}):`,
      renderRules(neighbourhoodRules(communityFacts)),
    );
  }
  sections.push(
    '',
    `End every narrative with exactly this sentence: "${NARRATIVE_FOOTER}"`,
  );
  return sections.join('\n');
}

/**
 * Neighbourhood instruction block. The LLM covers why the area appeals, its
 * schools and their ratings, how the community ranks within Calgary,
 * nearby shops and markets, public transport access and nearby amenities,
 * and the average single-family home price — hedged wherever its knowledge
 * may be stale. No fake precision: never a precise rating, score, or
 * schedule stated as fact.
 */
function neighbourhoodRules(facts: CommunityFacts): string[] {
  const rules = [
    'Cover the neighbourhood for a homebuyer: why this area appeals, nearby schools and how they rate, how the area ranks within Calgary, nearby shops and markets, public transport access and nearby amenities, and the average single-family home price.',
    'Where your knowledge may be stale — school ratings, transit routes, new developments — hedge explicitly ("as of my last update", "worth confirming with the school board") and never state a precise rating, score, or schedule as fact. Never invent school names or ratings.',
  ];
  if (facts.avgSingleFamilyAssessedValue != null) {
    rules.push(
      'The average single-family home price below is a City-assessed value, not a market value — say so. Never restate it approximately: copy the figure exactly or leave it out.',
    );
  }
  return rules;
}

/** Neighbourhood stats section for the user prompt; empty when unknown. */
function neighbourhoodLines(facts: CommunityFacts | undefined): string[] {
  if (!facts) return [];
  const vintage = facts.dataVintage ? `, refreshed ${facts.dataVintage}` : '';
  const lines = [
    '',
    `Neighbourhood: ${facts.community} (City of Calgary assessment data${vintage})`,
  ];
  if (facts.avgSingleFamilyAssessedValue != null) {
    lines.push(
      `- Average single-family home assessed value: ${formatCadWhole(facts.avgSingleFamilyAssessedValue)} (City-assessed value, not market value)`,
    );
  }
  if (facts.assessedHomeCount != null) {
    lines.push(`- Homes assessed: ${formatWhole(facts.assessedHomeCount)}`);
  }
  if (facts.avgLotSqft != null) {
    lines.push(`- Average lot size: ${formatWhole(facts.avgLotSqft)} sqft`);
  }
  return lines;
}

function buildUserPrompt(input: NarrativePromptInput): string {
  const { projectType, cityFacts, communityFacts } = input;
  const community = cityFacts.community
    ? `${cityFacts.community}, ${cityFacts.city}`
    : cityFacts.city;
  const project =
    projectType === 'renovation' ? 'Home renovation' : 'New home build';
  // Neighbourhood-only prompt: engine figures and assumptions are
  // deliberately NOT interpolated — the narrative is about the
  // neighbourhood, and the report displays the cost breakdown separately.
  // The only $-figure the model ever sees is the published community
  // average inside the neighbourhood stats below.
  return [
    `Project: ${project} in ${community}`,
    ...neighbourhoodLines(communityFacts),
  ].join('\n');
}

/**
 * Build the LLM prompt for an estimate narrative. Interpolates ONLY the
 * project context (project type + place), CityFacts, and CommunityFacts —
 * never engine figures or assumptions, and never CostData / CostParams
 * (compile-time enforced by the parameter type). The narrative is about
 * the neighbourhood only; the report displays the cost breakdown
 * separately.
 */
export function buildNarrativePrompt(input: NarrativePromptInput): NarrativePrompt {
  return {
    system: buildSystemPrompt(input.projectType, input.cityFacts, input.communityFacts),
    user: buildUserPrompt(input),
  };
}

/** Result of validating a generated narrative against the engine output. */
export interface NarrativeValidation {
  readonly ok: boolean;
  /** Human-readable violation descriptions; empty when ok. */
  readonly violations: readonly string[];
}

/**
 * Validate a generated narrative: every $-figure must be one the engine
 * produced (or the published community average, when `communityFacts` was
 * part of the prompt). The verbatim footer is NOT validated here — the
 * narrative worker appends it deterministically via `ensureNarrativeFooter()`
 * before validation, so a model that omits it can no longer fail an
 * otherwise good narrative.
 */
export function validateNarrative(
  narrative: string,
  estimate: EstimateOutput,
  communityFacts?: CommunityFacts,
): NarrativeValidation {
  const violations: string[] = [];
  const allowed = new Set(allowedNarrativeFigures(estimate));
  if (communityFacts?.avgSingleFamilyAssessedValue != null) {
    allowed.add(formatCadWhole(communityFacts.avgSingleFamilyAssessedValue));
  }
  const figures = narrative.match(FIGURE_PATTERN) ?? [];
  for (const figure of figures) {
    if (!allowed.has(figure)) {
      violations.push(`Invented dollar figure not from the engine output: "${figure}"`);
    }
  }
  return { ok: violations.length === 0, violations };
}
