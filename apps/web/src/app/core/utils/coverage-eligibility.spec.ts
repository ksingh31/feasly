/**
 * Estimator eligibility guarantees (#685).
 *
 * 1. Fixture replay: the top 25 `land_use_designation` values for
 *    single-detached homes (sub_property_use R110, dataset 4bsw-nn7w,
 *    captured 2026-11-15) are replayed with the stale blanket-rezoning token
 *    stripped — what the City will return once the roll is refreshed after
 *    the 2026-08-04 repeal. Homes that are quotable on today's raw value must
 *    stay quotable (>= 99%), so a data refresh can never mass-reject them
 *    (the #562 failure, at scale).
 * 2. No district code literal in coverage.ts — the list comes from config.
 * 3. The zoning guide table cannot drift from the configured list.
 * 4. The how-it-works card and FAQ copy do not enumerate districts (so they
 *    cannot go stale when the list changes).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from '../config/app-config.defaults';
import { pricingCoverageIssue, type PricingCoverageBounds } from './coverage';

const here = dirname(fileURLToPath(import.meta.url));
const DISTRICTS = DEFAULT_APP_CONFIG.coverage.singleFamilyDistricts.calgary;
const BOUNDS: PricingCoverageBounds = DEFAULT_APP_CONFIG.limits;

interface FixtureRow {
  designation: string;
  homes: number;
}
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'r110-land-use-top25.json'), 'utf8')) as {
  rows: FixtureRow[];
};

/**
 * The 2024 blanket rezoning appended R-CG (established areas) or R-G
 * (developing areas) to each parcel's previous district; the repeal reverts
 * to the previous district. Strip those tokens when another district
 * remains; a lone R-CG/R-G is a genuine designation and stays.
 */
const BLANKET_REZONING_TOKENS = new Set(['R-CG', 'R-G']);
function stripStaleToken(designation: string): string {
  const tokens = designation.split(',').map((t) => t.trim()).filter(Boolean);
  const kept = tokens.filter((t) => !BLANKET_REZONING_TOKENS.has(t.toUpperCase()));
  return (kept.length > 0 ? kept : tokens).join(',');
}

const quotable = (zoning: string): boolean =>
  pricingCoverageIssue({ zoning, lotSqft: 5000, assessedValue: 700000, isNonResidential: false }, BOUNDS, DISTRICTS) ===
  null;

describe('estimator eligibility — fixture replay (#685 AC5)', () => {
  it('has the top 25 single-detached designations', () => {
    expect(fixture.rows).toHaveLength(25);
  });

  it('strips only the blanket-rezoning token', () => {
    expect(stripStaleToken('R-1N,R-G')).toBe('R-1N');
    expect(stripStaleToken('R-C1,R-CG')).toBe('R-C1');
    expect(stripStaleToken('DC,R-1N,R-G')).toBe('DC,R-1N');
    expect(stripStaleToken('R-G')).toBe('R-G');
    expect(stripStaleToken('H-GO,R-C1')).toBe('H-GO,R-C1');
  });

  it('keeps at least 99% of currently-quotable single-detached homes quotable after the refresh', () => {
    let quotableNow = 0;
    let stillQuotable = 0;
    for (const row of fixture.rows) {
      if (!quotable(row.designation)) continue;
      quotableNow += row.homes;
      if (quotable(stripStaleToken(row.designation))) stillQuotable += row.homes;
    }
    expect(quotableNow).toBeGreaterThan(0);
    expect(stillQuotable / quotableNow).toBeGreaterThanOrEqual(0.99);
  });

  it('every reverted designation in the fixture is quotable on its own', () => {
    for (const code of ['R-1N', 'R-1', 'R-1s', 'R-2', 'R-2M', 'R-C1N', 'R-C1L', 'R-C1s', 'R-C1', 'R-C2']) {
      expect(quotable(code)).toBe(true);
    }
  });
});

describe('estimator eligibility — single source (#685 AC3/AC4)', () => {
  const norm = (code: string): string => code.trim().toUpperCase();
  const configured = new Set(DISTRICTS.map(norm));

  it('coverage.ts carries no district code literal', () => {
    const src = readFileSync(join(here, 'coverage.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).not.toMatch(/['"`](DC|[A-Z]{1,3}-[A-Za-z0-9]+)['"`]/);
  });

  it('the zoning guide table marks exactly the configured districts as buildable', () => {
    const zones = DEFAULT_APP_CONFIG.copy.marketing.zoningGuide.zones;
    const yes = new Set<string>();
    const notYes = new Set<string>();
    for (const zone of zones) {
      const codes = zone.code.split('/').map(norm);
      for (const code of codes) (zone.build.startsWith('Yes') ? yes : notYes).add(code);
    }
    // Every "Yes" row is quoted…
    for (const code of yes) expect(configured, `guide says ${code} is buildable`).toContain(code);
    // …and every quoted district appears in the table ("DC" is the "Maybe" row, quoted fail-open).
    for (const code of configured) {
      if (code === 'DC') {
        expect(notYes).toContain('DC');
        continue;
      }
      expect(yes, `quoted district ${code} missing from the guide table`).toContain(code);
    }
  });

  it('the how-it-works card and the FAQ answer do not enumerate districts', () => {
    const faq = DEFAULT_APP_CONFIG.copy.marketing.zoningGuide.faqs.find((f) => f.anchor === 'why-single-family-only');
    expect(faq).toBeDefined();
    const card = DEFAULT_APP_CONFIG.copy.marketing.howItWorks.zoningCardBody;
    for (const text of [card, faq?.a ?? '']) {
      for (const code of configured) {
        if (code === 'DC') continue;
        expect(text.toUpperCase()).not.toMatch(new RegExp(`\\b${code.replace(/-/g, '\\-')}\\b`));
      }
    }
  });
});
