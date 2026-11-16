/**
 * Calgary catalogue data tests (issue #687 AC1, AC7; owner decision
 * 2026-11-15: "a unit test per district").
 *
 * The zod-schema validation of every registered catalogue lives in
 * apps/api/test/zoning.test.ts (zod is an API dependency; this package has
 * none).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILDING_FORMS } from '@feasly/contracts';
import { CALGARY_2026_08_04, createZoningResolver, normalizeDistrictCode } from '../src';

interface LiveCodesFixture {
  readonly capturedOn: string;
  readonly codes: readonly string[];
}

const live = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'calgary-live-codes-2026-11-15.json'), 'utf8'),
) as LiveCodesFixture;
const resolver = createZoningResolver([CALGARY_2026_08_04]);

describe('every live district code is mapped (AC1)', () => {
  it('fixture is the qe6k-p9nh code list', () => {
    expect(live.codes.length).toBeGreaterThanOrEqual(30);
    expect(live.codes).toContain('R-CG');
  });

  it.each(live.codes.map((c) => [c]))('%s has an entry (covered, site-specific or not-covered)', (code) => {
    const r = resolver.resolve('calgary', code);
    expect(r.status).not.toBe('unknown');
    expect(r.matchedBy).toBe('code');
  });

  it('every residential live code is described, not just named', () => {
    const residential = live.codes.filter((c) => /^(R-|M-|H-GO$)/.test(c) && c !== 'R-MH');
    for (const code of residential) {
      expect(resolver.resolve('calgary', code).status, code).toBe('covered');
    }
  });
});

describe('catalogue shape', () => {
  it('codes and aliases are unique after normalisation', () => {
    const keys = CALGARY_2026_08_04.districts.flatMap((d) => [d.code, ...(d.aliases ?? [])]).map(normalizeDistrictCode);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('forms come from the fixed vocabulary, once each per district', () => {
    for (const d of CALGARY_2026_08_04.districts) {
      const seen = d.forms.map((f) => f.form);
      expect(new Set(seen).size, d.code).toBe(seen.length);
      for (const f of seen) expect(BUILDING_FORMS).toContain(f);
    }
  });

  it('only covered districts carry forms or rules', () => {
    for (const d of CALGARY_2026_08_04.districts) {
      if (d.coverage !== 'covered') {
        expect(d.forms, d.code).toEqual([]);
        expect(d.rules, d.code).toEqual({});
      }
    }
  });
});

const covered = CALGARY_2026_08_04.districts.filter((d) => d.coverage === 'covered');

describe.each(covered.map((d) => [d.code, d] as const))('district %s', (code, d) => {
  it('has at least one verified form', () => {
    expect(resolver.resolve('calgary', code).district?.forms.length).toBeGreaterThan(0);
  });

  it('cites a bylaw section on every form and rule', () => {
    for (const f of d.forms) expect(f.section).toMatch(/^s\. \d+(\.\d+)?(\([a-z0-9.]+\))*$/);
    for (const r of Object.values(d.rules)) expect(r?.section).toMatch(/^s\. \d+(\.\d+)?(\([a-z0-9.]+\))*$/);
  });

  it('rule values are in plausible ranges', () => {
    const { maxHeightM, maxLotCoveragePct, maxDensityUnitsPerHa, maxUnitsOnLot } = d.rules;
    if (maxHeightM) expect(maxHeightM.value).toBeGreaterThan(0);
    if (maxHeightM) expect(maxHeightM.value).toBeLessThanOrEqual(100);
    if (maxLotCoveragePct) expect(maxLotCoveragePct.value).toBeGreaterThan(0);
    if (maxLotCoveragePct) expect(maxLotCoveragePct.value).toBeLessThanOrEqual(100);
    if (maxDensityUnitsPerHa) expect(Number.isInteger(maxDensityUnitsPerHa.value)).toBe(true);
    if (maxUnitsOnLot) expect(Number.isInteger(maxUnitsOnLot.value)).toBe(true);
  });
});

describe('no dollar figures (AC7)', () => {
  const MONEY_KEY = /cost|price|dollar|cents|amount|value_?cad|fee|budget/i;
  const collectKeys = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) for (const x of v) collectKeys(x, out);
    else if (v && typeof v === 'object')
      for (const [k, c] of Object.entries(v)) {
        out.push(k);
        collectKeys(c, out);
      }
    return out;
  };

  it('catalogue and resolver output have no money keys or $ amounts', () => {
    const outputs = [
      CALGARY_2026_08_04,
      resolver.catalogue('calgary'),
      ...covered.map((d) => resolver.resolve('calgary', d.code, { areaSqm: 600 })),
    ];
    for (const o of outputs) {
      expect(collectKeys(o).filter((k) => MONEY_KEY.test(k))).toEqual([]);
      expect(JSON.stringify(o)).not.toMatch(/\$\s?\d|CA\$|CAD\b/);
    }
  });

  it('package source has no $ amounts', () => {
    for (const f of ['resolver.ts', 'catalogues.ts', 'index.ts', join('data', 'calgary-2026-08-04.ts')]) {
      const src = readFileSync(join(__dirname, '..', 'src', f), 'utf8');
      expect(src, f).not.toMatch(/\$\s?\d|CA\$/);
    }
  });
});

describe('purity', () => {
  it('src imports nothing but @feasly/contracts types and local modules', () => {
    for (const f of ['resolver.ts', 'catalogues.ts', 'index.ts', join('data', 'calgary-2026-08-04.ts')]) {
      const src = readFileSync(join(__dirname, '..', 'src', f), 'utf8');
      const specifiers = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '');
      for (const s of specifiers) expect(s === '@feasly/contracts' || s.startsWith('.'), `${f}: ${s}`).toBe(true);
      expect(src).not.toMatch(/Date\.now|new Date\(|process\.|fetch\(/);
    }
  });
});
