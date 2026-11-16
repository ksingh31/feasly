/**
 * Writes the web app's "What this estimate includes" list from the cost
 * engine's actual line items (#824). The active cost-data table is the single
 * source of truth: every hard-cost, soft-cost and contingency row the engine
 * emits becomes one list entry, in engine row order. The web app must never
 * import this package, so it imports a generated data file instead of
 * keeping a hand-written list. `test/web-scope-agreement.test.ts` fails CI
 * when the committed file is out of date — so when a new line item (e.g.
 * demolition, #825) lands in the cost data, it moves into "includes" and out
 * of the config's "not included" list on the next regenerate.
 *
 * The land row is left out: land is the City-assessed lot value, shown as
 * its own figure, not a build line item.
 *
 * #827: the same file carries the How it works worked example — a sample
 * home priced by `createEstimate()` at generation time, grouped into the
 * page's formula (hard costs + soft costs + contingency = build range). The
 * web app only displays these figures; it never computes them.
 *
 * Usage (from the repo root): npm run gen:web-scope --workspace @feasly/cost-engine
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addBands, zeroBand } from '../src/bands';
import { PLACEHOLDER_COST_DATA } from '../src/cost-data';
import { createEstimate } from '../src/engine';
import type { CostData, FinishTier, RangedAmount } from '../src/types';

export const WEB_SCOPE_FILE = join(
  __dirname,
  '..',
  '..',
  '..',
  'apps',
  'web',
  'src',
  'app',
  'core',
  'config',
  'estimate-scope.generated.ts',
);

export interface ScopeLineItem {
  readonly key: string;
  readonly label: string;
}

/**
 * The build line items a new-build estimate prices, in the same order and
 * with the same keys and labels as `createEstimate()` rows (land excluded).
 */
export function estimateLineItems(costData: CostData): ScopeLineItem[] {
  return [
    ...Object.entries(costData.hardCosts).map(([key, c]) => ({ key: `hard.${key}`, label: c.label })),
    ...Object.entries(costData.softCosts).map(([key, c]) => ({ key: `soft.${key}`, label: c.label })),
    { key: 'contingency', label: costData.contingency.label },
  ];
}

/** The fictional sample home the How it works page prices (#827). */
export const WORKED_EXAMPLE_INPUT = {
  buildSqft: 2_400,
  tier: 'standard' as FinishTier,
  /** A common Calgary infill lot (50 ft × 120 ft); site prep scales with it. */
  lotSizeSqft: 6_000,
} as const;

/** Formula group of an engine row key: `hard.*`, `soft.*`, `contingency`. */
export type FormulaGroupKey = 'hard' | 'soft' | 'contingency';

export interface WorkedExampleRow {
  readonly key: string;
  readonly label: string;
  readonly range: RangedAmount;
}

export interface WorkedExampleGroup {
  readonly key: FormulaGroupKey;
  readonly rows: readonly WorkedExampleRow[];
  readonly subtotal: RangedAmount;
}

export interface WorkedExample {
  readonly costDataVersion: string;
  readonly input: typeof WORKED_EXAMPLE_INPUT;
  readonly groups: readonly WorkedExampleGroup[];
  /** The engine's build band (`totals.build`). Land is not part of the example. */
  readonly build: RangedAmount;
}

function groupOf(key: string): FormulaGroupKey {
  if (key.startsWith('hard.')) return 'hard';
  if (key.startsWith('soft.')) return 'soft';
  return 'contingency';
}

/**
 * Prices the sample home with the engine and groups its rows by formula
 * term. The land row is dropped: a fictional lot has no City assessment, and
 * land is shown as its own fixed figure in a real estimate. The assessed
 * value passed in only satisfies the engine's input bounds — it reaches no
 * emitted figure.
 */
export function workedExample(costData: CostData): WorkedExample {
  const result = createEstimate(
    {
      property: {
        assessedLandValue: costData.inputBounds.minAssessedLandValue,
        lotSizeSqft: WORKED_EXAMPLE_INPUT.lotSizeSqft,
        zoning: 'R-C1',
      },
      scope: { buildSqft: WORKED_EXAMPLE_INPUT.buildSqft, tier: WORKED_EXAMPLE_INPUT.tier },
    },
    costData,
  );
  const order: FormulaGroupKey[] = ['hard', 'soft', 'contingency'];
  const groups = order.map((key) => {
    const rows = result.rows
      .filter((r) => r.key !== 'land' && groupOf(r.key) === key)
      .map((r) => ({ key: r.key, label: r.label, range: { ...r.range } }));
    const subtotal = rows.reduce((acc, r) => addBands(acc, r.range), zeroBand());
    return { key, rows, subtotal };
  });
  return {
    costDataVersion: result.costDataVersion,
    input: WORKED_EXAMPLE_INPUT,
    groups,
    build: { ...result.totals.build },
  };
}

function rangeLiteral(r: RangedAmount): string {
  return `{ low: ${r.low}, base: ${r.base}, high: ${r.high} }`;
}

function renderWorkedExample(costData: CostData): string {
  const ex = workedExample(costData);
  const groups = ex.groups
    .map((g) => {
      const rows = g.rows
        .map((r) => `        { key: ${quote(r.key)}, label: ${quote(r.label)}, range: ${rangeLiteral(r.range)} },`)
        .join('\n');
      return `    {
      key: ${quote(g.key)},
      rows: [
${rows}
      ],
      subtotal: ${rangeLiteral(g.subtotal)},
    },`;
    })
    .join('\n');
  return `/**
 * How it works worked example (#827): a fictional ${ex.input.buildSqft} sq ft
 * ${ex.input.tier}-finish home on a ${ex.input.lotSizeSqft} sq ft lot, priced by the
 * cost engine's createEstimate() and grouped by formula term (hard costs +
 * soft costs + contingency = build range). Whole CAD dollars. Land is not
 * included: a fictional lot has no City assessment.
 */
export const ESTIMATE_WORKED_EXAMPLE = {
  costDataVersion: ${quote(ex.costDataVersion)},
  input: { buildSqft: ${ex.input.buildSqft}, tier: ${quote(ex.input.tier)}, lotSizeSqft: ${ex.input.lotSizeSqft} },
  groups: [
${groups}
  ],
  build: ${rangeLiteral(ex.build)},
} as const;
`;
}

function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** The exact text of the generated file. */
export function renderWebScope(costData: CostData = PLACEHOLDER_COST_DATA): string {
  const items = estimateLineItems(costData)
    .map((i) => `    { key: ${quote(i.key)}, label: ${quote(i.label)} },`)
    .join('\n');
  return `// GENERATED by packages/cost-engine/tools/gen-web-scope.ts — do not edit.
// Source: cost data ${costData.version}.
// Regenerate: npm run gen:web-scope --workspace @feasly/cost-engine

/**
 * The build line items every new-build estimate prices (#824), taken from
 * the cost engine's active cost-data table in engine row order. Land is not
 * listed: it is the City-assessed lot value, shown as its own figure.
 */
export const ESTIMATE_LINE_ITEMS = {
  costDataVersion: ${quote(costData.version)},
  items: [
${items}
  ],
} as const;

${renderWorkedExample(costData)}`;
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  writeFileSync(WEB_SCOPE_FILE, renderWebScope());
  console.log(`wrote ${WEB_SCOPE_FILE}`);
}
