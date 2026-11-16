/**
 * Catalogue ↔ estimator eligibility agreement (#898).
 *
 * The web app quotes a single-family build only in the districts listed in
 * `coverage.singleFamilyDistricts.calgary` (Karan, 2026-10-02: every zone
 * where a single-detached dwelling is a listed use). The "What's typically
 * allowed" panel is driven by this catalogue. The two must agree for every
 * district, or one surface quotes a house the other says isn't listed.
 *
 * The web config is read as text (apps/web does not depend on this package
 * and this package must not depend on the web app).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CALGARY_2026_08_04, createZoningResolver, normalizeDistrictCode } from '../src';

const WEB_DEFAULTS = join(__dirname, '..', '..', '..', 'apps', 'web', 'src', 'app', 'core', 'config', 'app-config.defaults.ts');

/** Extracts the `singleFamilyDistricts: { … calgary: [ … ] }` string list. */
function configuredCalgaryDistricts(): string[] {
  const src = readFileSync(WEB_DEFAULTS, 'utf8');
  const block = /singleFamilyDistricts:\s*\{[\s\S]*?calgary:\s*\[([\s\S]*?)\]/.exec(src);
  if (!block?.[1]) throw new Error('coverage.singleFamilyDistricts.calgary not found in app-config.defaults.ts');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

const resolver = createZoningResolver([CALGARY_2026_08_04]);
const configured = configuredCalgaryDistricts();
const quoted = configured.filter((c) => normalizeDistrictCode(c) !== normalizeDistrictCode('DC'));
const singleDetached = (code: string): boolean =>
  resolver.resolve('calgary', code).district?.forms.some((f) => f.form === 'single-detached') ?? false;

describe('estimator eligibility agrees with the zoning catalogue (#898)', () => {
  it('reads the configured list', () => {
    expect(quoted.length).toBeGreaterThanOrEqual(10);
    expect(configured).toContain('DC');
  });

  it.each(quoted.map((c) => [c]))('quoted district %s lists single-detached in the catalogue', (code) => {
    const r = resolver.resolve('calgary', code);
    expect(r.status, code).toBe('covered');
    expect(singleDetached(code), `${code} is quoted but the catalogue has no single-detached form`).toBe(true);
  });

  it('every catalogue district listing single-detached is quoted (or a named, reasoned exclusion)', () => {
    // Excluded on purpose — see the comment on singleFamilyDistricts.calgary.
    const EXCLUDED = new Map<string, string>([
      ['R-Gm', '#911: config says the "m" modifier removes single-detached; catalogue lists it discretionary'],
      ['R-CGex', '#911: pending bylaw verification before it is quoted'],
    ]);
    const configuredKeys = new Set(configured.map(normalizeDistrictCode));
    const missing = CALGARY_2026_08_04.districts
      .filter((d) => d.coverage === 'covered' && singleDetached(d.code))
      .map((d) => d.code)
      .filter((code) => !configuredKeys.has(normalizeDistrictCode(code)) && !EXCLUDED.has(code));
    expect(missing).toEqual([]);
  });

  it('DC stays fail-open: site-specific in the catalogue, quoted by the estimator', () => {
    expect(resolver.resolve('calgary', 'DC').status).toBe('site-specific');
  });
});
