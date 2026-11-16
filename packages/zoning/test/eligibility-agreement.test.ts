/**
 * Catalogue ↔ estimator eligibility agreement (#898, #911).
 *
 * Owner decision (2026-11-15): the zoning catalogue is the single source of
 * truth. The web app quotes a single-family build only in districts with a
 * cited single-detached use (permitted or discretionary), plus Direct
 * Control (fail-open). Its list is GENERATED from the catalogue by
 * tools/gen-web-eligibility.ts; these tests fail when the committed file is
 * stale or the web config stops using it.
 *
 * The web files are read as text (apps/web does not depend on this package
 * and this package must not depend on the web app).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ZoningRulesVersion } from '@feasly/contracts';
import { CALGARY_2026_08_04, createZoningResolver, singleDetachedEligibility } from '../src';
import { renderWebEligibility, WEB_ELIGIBILITY_FILE } from '../tools/gen-web-eligibility';

const WEB_DEFAULTS = join(__dirname, '..', '..', '..', 'apps', 'web', 'src', 'app', 'core', 'config', 'app-config.defaults.ts');

const resolver = createZoningResolver([CALGARY_2026_08_04]);
const calgary = singleDetachedEligibility(CALGARY_2026_08_04);

describe('estimator eligibility is derived from the zoning catalogue (#911)', () => {
  it('the committed web file is up to date (run: npm run gen:web-eligibility --workspace @feasly/zoning)', () => {
    expect(readFileSync(WEB_ELIGIBILITY_FILE, 'utf8')).toBe(renderWebEligibility());
  });

  it('the web config reads both lists from the generated file, not an inline list', () => {
    const src = readFileSync(WEB_DEFAULTS, 'utf8');
    expect(src).toMatch(/singleFamilyDistricts:\s*\{[\s\S]*?calgary:\s*ZONING_ELIGIBILITY\.calgary\.quotable/);
    expect(src).toMatch(
      /discretionarySingleFamilyDistricts:\s*\{[\s\S]*?calgary:\s*ZONING_ELIGIBILITY\.calgary\.discretionary/,
    );
  });

  it('every quoted code resolves to a cited single-detached use, or to site-specific DC', () => {
    expect(calgary.quotable.length).toBeGreaterThanOrEqual(10);
    for (const code of calgary.quotable) {
      const r = resolver.resolve('calgary', code);
      if (r.status === 'site-specific') continue;
      expect(r.status, code).toBe('covered');
      const sd = r.district?.forms.find((f) => f.form === 'single-detached');
      expect(sd, `${code} is quoted but has no cited single-detached form`).toBeDefined();
      expect(sd?.permission === 'discretionary', code).toBe(calgary.discretionary.includes(code));
    }
  });

  it('every covered district with a cited single-detached use is quoted', () => {
    const missing = CALGARY_2026_08_04.districts
      .filter((d) => d.coverage === 'covered')
      .filter((d) => resolver.resolve('calgary', d.code).district?.forms.some((f) => f.form === 'single-detached'))
      .map((d) => d.code)
      .filter((code) => !calgary.quotable.includes(code));
    expect(missing).toEqual([]);
  });

  it('R-Gm is quoted as discretionary (s. 547.3(2)(a))', () => {
    expect(calgary.quotable).toContain('R-Gm');
    expect(calgary.discretionary).toContain('R-Gm');
  });

  it('R-CGex has no cited single-detached entry, so it is not quoted (#757 review)', () => {
    expect(calgary.quotable).not.toContain('R-CGex');
    const sd = resolver.resolve('calgary', 'R-CGex').district?.forms.find((f) => f.form === 'single-detached');
    expect(sd).toBeUndefined();
  });

  it('DC stays fail-open: site-specific in the catalogue, quoted by the estimator', () => {
    expect(resolver.resolve('calgary', 'DC').status).toBe('site-specific');
    expect(calgary.quotable).toContain('DC');
    expect(calgary.discretionary).not.toContain('DC');
  });

  it('permitted districts carry no approval note', () => {
    for (const code of ['R-C1', 'R-C2', 'R-1', 'R-G', 'H-GO']) {
      expect(calgary.quotable).toContain(code);
      expect(calgary.discretionary).not.toContain(code);
    }
  });
});

describe('singleDetachedEligibility', () => {
  const version: ZoningRulesVersion = {
    city: 'testville',
    effectiveDate: '2026-01-01',
    bylaw: 'Test bylaw',
    bylawVersion: '1',
    sourceUrl: 'https://example.test/bylaw',
    districts: [
      {
        code: 'P',
        name: 'Permitted',
        category: 'low-density',
        coverage: 'covered',
        aliases: ['P1'],
        forms: [{ form: 'single-detached', permission: 'permitted', section: 's. 1', verified: true }],
        rules: {},
      },
      {
        code: 'D',
        name: 'Discretionary',
        category: 'low-density',
        coverage: 'covered',
        forms: [{ form: 'single-detached', permission: 'discretionary', section: 's. 2', verified: true }],
        rules: {},
      },
      {
        code: 'U',
        name: 'Uncited',
        category: 'low-density',
        coverage: 'covered',
        forms: [{ form: 'single-detached', permission: 'permitted', section: 's. 3', verified: false }],
        rules: {},
      },
      {
        code: 'N',
        name: 'No single-detached',
        category: 'multi-residential',
        coverage: 'covered',
        forms: [{ form: 'semi-detached', permission: 'permitted', section: 's. 4', verified: true }],
        rules: {},
      },
      {
        code: 'X',
        name: 'Not covered',
        category: 'non-residential',
        coverage: 'not-covered',
        forms: [{ form: 'single-detached', permission: 'permitted', section: 's. 5', verified: true }],
        rules: {},
      },
      { code: 'S', name: 'Site specific', category: 'direct-control', coverage: 'site-specific', forms: [], rules: {} },
    ],
  };

  it('quotes permitted, discretionary and site-specific districts by canonical code; flags discretionary', () => {
    expect(singleDetachedEligibility(version)).toEqual({ quotable: ['P', 'D', 'S'], discretionary: ['D'] });
  });
});
