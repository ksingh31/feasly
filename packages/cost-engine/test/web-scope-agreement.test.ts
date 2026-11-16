/**
 * #824: the web app's "What this estimate includes" list is GENERATED from
 * the engine's line items by tools/gen-web-scope.ts. These tests fail when
 * the committed web file is stale, when the generator stops matching what
 * `createEstimate()` actually emits, or when the web config stops reading
 * the generated list.
 *
 * The web files are read as text: apps/web must never import this package.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEstimate, PLACEHOLDER_COST_DATA } from '../src';
import { estimateLineItems, renderWebScope, WEB_SCOPE_FILE } from '../tools/gen-web-scope';

const WEB_DEFAULTS = join(__dirname, '..', '..', '..', 'apps', 'web', 'src', 'app', 'core', 'config', 'app-config.defaults.ts');

describe('estimate includes list is derived from the engine line items (#824)', () => {
  it('the committed web file is up to date (run: npm run gen:web-scope --workspace @feasly/cost-engine)', () => {
    expect(readFileSync(WEB_SCOPE_FILE, 'utf8')).toBe(renderWebScope());
  });

  it('matches the rows createEstimate() emits for every tier, minus the land row', () => {
    for (const tier of ['standard', 'premium', 'luxury'] as const) {
      const result = createEstimate(
        {
          property: { assessedLandValue: 400_000, lotSizeSqft: 5_000, zoning: 'R-CG' },
          scope: { buildSqft: 2_400, tier },
        },
        PLACEHOLDER_COST_DATA,
      );
      const engineItems = result.rows.filter((r) => r.key !== 'land').map((r) => ({ key: r.key, label: r.label }));
      expect(estimateLineItems(PLACEHOLDER_COST_DATA)).toEqual(engineItems);
    }
  });

  it('a line item added to the cost data shows up in the list', () => {
    const withDemolition = {
      ...PLACEHOLDER_COST_DATA,
      hardCosts: {
        ...PLACEHOLDER_COST_DATA.hardCosts,
        demolition: { ...PLACEHOLDER_COST_DATA.hardCosts['sitePrep']!, label: 'Demolition' },
      },
    };
    expect(estimateLineItems(withDemolition)).toContainEqual({ key: 'hard.demolition', label: 'Demolition' });
    expect(renderWebScope(withDemolition)).toContain("{ key: 'hard.demolition', label: 'Demolition' },");
  });

  it('the web config reads the includes list from the generated file, not an inline list', () => {
    const src = readFileSync(WEB_DEFAULTS, 'utf8');
    expect(src).toMatch(/estimateScope:\s*\{[\s\S]*?includes:\s*ESTIMATE_LINE_ITEMS\.items/);
  });
});
