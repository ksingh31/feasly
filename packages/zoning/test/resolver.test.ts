/**
 * Zoning resolver tests (issue #687 ACs 2, 3, 4, 6).
 */
import { describe, expect, it } from 'vitest';
import type { ZoningRulesVersion } from '@feasly/contracts';
import { CALGARY_2026_08_04, ZONING_CATALOGUES, createZoningResolver, normalizeDistrictCode } from '../src';
import { TESTVILLE_2025_01_01, TESTVILLE_2026_06_01 } from './fixtures/testville';

const resolver = createZoningResolver(ZONING_CATALOGUES);
const forms = (code: string): string[] =>
  (resolver.resolve('calgary', code).district?.forms ?? []).map((f) => `${f.form}:${f.permission}`);

describe('resolve — Calgary districts (AC2)', () => {
  it('R-C1: single-detached permitted, suites discretionary, cited rules', () => {
    const r = resolver.resolve('calgary', 'R-C1');
    expect(r.status).toBe('covered');
    expect(r.matchedBy).toBe('code');
    expect(r.source).toMatchObject({ city: 'calgary', effectiveDate: '2026-08-04' });
    expect(r.source?.sourceUrl).toMatch(/^https:\/\/www\.calgary\.ca\//);
    expect(forms('R-C1')).toEqual([
      'single-detached:permitted',
      'secondary-suite:discretionary',
      'backyard-suite:discretionary',
    ]);
    expect(r.district?.rules.maxHeightM).toMatchObject({ value: 10, section: 's. 399' });
    expect(r.district?.rules.maxLotCoveragePct).toMatchObject({ value: 45, section: 's. 393' });
    expect(r.district?.rules.maxDensityUnitsPerHa).toBeUndefined();
  });

  it('R-C2: adds semi-detached (permitted) and duplex (discretionary)', () => {
    expect(forms('R-C2')).toEqual([
      'single-detached:permitted',
      'semi-detached:permitted',
      'duplex:discretionary',
      'secondary-suite:permitted',
      'backyard-suite:discretionary',
    ]);
  });

  it('R-CG: grade-oriented forms + verified 75 units/ha; unverified amendments hidden', () => {
    const r = resolver.resolve('calgary', 'R-CG');
    expect(r.district?.category).toBe('grade-oriented');
    expect(forms('R-CG')).toEqual(
      expect.arrayContaining(['rowhouse:permitted', 'townhouse:discretionary', 'secondary-suite:permitted']),
    );
    expect(r.district?.rules.maxDensityUnitsPerHa).toMatchObject({ value: 75, section: 's. 529' });
    // Reported 2026 amendments are verified:false in the data → absent (AC3).
    expect(r.district?.rules.maxHeightM).toBeUndefined();
    expect(r.district?.rules.maxLotCoveragePct).toBeUndefined();
  });

  it('R-CGex: no suites', () => {
    expect(forms('R-CGex').some((f) => f.includes('suite'))).toBe(false);
  });

  it('H-GO: grade-oriented, 12 m height', () => {
    const r = resolver.resolve('calgary', 'H-GO');
    expect(r.status).toBe('covered');
    expect(r.district?.category).toBe('grade-oriented');
    expect(r.district?.rules.maxHeightM?.value).toBe(12);
  });

  it('M-C1: multi-residential with 148 units/ha', () => {
    const r = resolver.resolve('calgary', 'M-C1');
    expect(r.district?.category).toBe('multi-residential');
    expect(forms('M-C1')).toEqual(['multi-residential:discretionary']);
    expect(r.district?.rules.maxDensityUnitsPerHa?.value).toBe(148);
  });

  it('DC: site-specific, no forms, points at the DC bylaw', () => {
    const r = resolver.resolve('calgary', 'DC');
    expect(r.status).toBe('site-specific');
    expect(r.district?.category).toBe('direct-control');
    expect(r.district?.forms).toEqual([]);
    expect(r.district?.note).toMatch(/Direct Control bylaw/);
  });

  it('unknown code fails open: status unknown, no district', () => {
    const r = resolver.resolve('calgary', 'R-ZZ9');
    expect(r).toEqual({
      status: 'unknown',
      requestedCode: 'R-ZZ9',
      source: expect.objectContaining({ city: 'calgary' }) as unknown,
    });
  });

  it.each([[''], ['   '], [null], [undefined]])('blank code %j → unknown', (code) => {
    const r = resolver.resolve('calgary', code);
    expect(r.status).toBe('unknown');
    expect(r.district).toBeUndefined();
  });

  it('a stale roll pair ("R-C2,R-CG") is not guessed at', () => {
    expect(resolver.resolve('calgary', 'R-C2,R-CG').status).toBe('unknown');
  });

  it('mixed case, spaces and typographic dashes resolve (R-C1S = R-C1s)', () => {
    for (const code of ['R-C1S', 'r-c1s', ' R-C1s ', 'R–C1s', 'R - C1s']) {
      const r = resolver.resolve('calgary', code);
      expect(r.district?.code).toBe('R-C1s');
      expect(r.matchedBy).toBe('code');
    }
    expect(normalizeDistrictCode(' r–c1s ')).toBe('R-C1S');
  });

  it('aliases resolve to their district', () => {
    const r = resolver.resolve('calgary', 'RC-1');
    expect(r.district?.code).toBe('R-C1');
    expect(r.matchedBy).toBe('alias');
  });

  it('modifiers resolve to the base district and drop the rule they replace', () => {
    const r = resolver.resolve('calgary', 'M-CGd75', { areaSqm: 1_000 });
    expect(r.status).toBe('covered');
    expect(r.matchedBy).toBe('modifier');
    expect(r.modifiers).toBe('d75');
    expect(r.district?.code).toBe('M-CG');
    expect(r.district?.rules.maxDensityUnitsPerHa).toBeUndefined();
    expect(r.indicativeMaxUnits).toBeUndefined();
    // M-H1 is a real code, not "M-" + height modifier "H1".
    expect(resolver.resolve('calgary', 'M-H1d200').district?.code).toBe('M-H1');
    expect(resolver.resolve('calgary', 'MU-1f3.0h16').status).toBe('not-covered');
  });

  it('not-covered districts are named but say nothing', () => {
    const r = resolver.resolve('calgary', 'C-COR1');
    expect(r.status).toBe('not-covered');
    expect(r.district?.forms).toEqual([]);
    expect(r.district?.rules).toEqual({});
  });

  it('unknown city → unknown with no source', () => {
    expect(resolver.resolve('atlantis', 'R-C1')).toEqual({ status: 'unknown', requestedCode: 'R-C1' });
    expect(resolver.catalogue('atlantis')).toBeUndefined();
  });
});

describe('unverified values are never shown (AC3)', () => {
  it('no verified flag and no unverified value reaches the output', () => {
    const cat = resolver.catalogue('calgary');
    expect(cat).toBeDefined();
    expect(JSON.stringify(cat)).not.toContain('verified');
    const unverifiedSections = new Set<string>();
    for (const d of CALGARY_2026_08_04.districts) {
      for (const f of d.forms) if (!f.verified) unverifiedSections.add(`${d.code}|form|${f.form}`);
      for (const [k, v] of Object.entries(d.rules)) if (v && !v.verified) unverifiedSections.add(`${d.code}|rule|${k}`);
    }
    expect(unverifiedSections.size).toBeGreaterThan(0);
    for (const d of cat?.districts ?? []) {
      for (const f of d.forms) expect(unverifiedSections.has(`${d.code}|form|${f.form}`)).toBe(false);
      for (const k of Object.keys(d.rules)) expect(unverifiedSections.has(`${d.code}|rule|${k}`)).toBe(false);
    }
  });

  it('an unverified density gives no unit count', () => {
    const r = createZoningResolver([TESTVILLE_2026_06_01]).resolve('testville', 'TV-R2', { areaSqm: 10_000 });
    expect(r.district?.rules.maxDensityUnitsPerHa).toBeUndefined();
    expect(r.indicativeMaxUnits).toBeUndefined();
  });
});

describe('indicative unit count (AC4)', () => {
  it('density × area, floored, deterministic', () => {
    // 75 units/ha × 533 m² = 3.9975 → 3
    const a = resolver.resolve('calgary', 'R-CG', { areaSqm: 533 });
    const b = resolver.resolve('calgary', 'R-CG', { areaSqm: 533 });
    expect(a.indicativeMaxUnits).toEqual({
      value: 3,
      densityUnitsPerHa: 75,
      lotAreaSqm: 533,
      section: 's. 529',
    });
    expect(b).toEqual(a);
    expect(Number.isInteger(a.indicativeMaxUnits?.value)).toBe(true);
  });

  it('exact boundary is not lost to floating point (75 × 400 m² = 3)', () => {
    expect(resolver.resolve('calgary', 'R-CG', { areaSqm: 400 }).indicativeMaxUnits?.value).toBe(3);
    // 148 × 0.0675 ha = 9.99 → 9
    expect(resolver.resolve('calgary', 'M-C1', { areaSqm: 675 }).indicativeMaxUnits?.value).toBe(9);
  });

  it.each([[undefined], [{}], [{ areaSqm: 0 }], [{ areaSqm: -5 }], [{ areaSqm: Number.NaN }], [{ areaSqm: Infinity }]])(
    'no result when lot area is missing/invalid: %j',
    (lot) => {
      expect(resolver.resolve('calgary', 'R-CG', lot).indicativeMaxUnits).toBeUndefined();
    },
  );

  it('no result under one unit, and none for a district without a density rule', () => {
    expect(resolver.resolve('calgary', 'R-CG', { areaSqm: 100 }).indicativeMaxUnits).toBeUndefined();
    expect(resolver.resolve('calgary', 'R-C1', { areaSqm: 5_000 }).indicativeMaxUnits).toBeUndefined();
  });
});

describe('second city is data only (AC6)', () => {
  const multi = createZoningResolver([...ZONING_CATALOGUES, TESTVILLE_2025_01_01, TESTVILLE_2026_06_01]);

  it('lists both cities and resolves the fixture city', () => {
    expect(multi.cities()).toEqual(['calgary', 'testville']);
    const r = multi.resolve('Testville', 'r1', { areaSqm: 1_000 });
    expect(r.status).toBe('covered');
    expect(r.district?.code).toBe('TV-R1');
    expect(r.matchedBy).toBe('alias');
    // 60 × 0.1 ha = 6, capped by maxUnitsOnLot 4
    expect(r.indicativeMaxUnits?.value).toBe(4);
    expect(multi.resolve('calgary', 'R-C1').district?.code).toBe('R-C1');
  });

  it('versions by effective date: newest by default, dated lookup with asOf', () => {
    expect(multi.catalogue('testville')?.effectiveDate).toBe('2026-06-01');
    expect(multi.catalogue('testville', { asOf: '2025-12-31' })?.effectiveDate).toBe('2025-01-01');
    expect(multi.catalogue('testville', { asOf: '2024-12-31' })).toBeUndefined();
    const old = multi.resolve('testville', 'TV-R1', { areaSqm: 1_000 }, { asOf: '2025-06-01' });
    expect(old.indicativeMaxUnits?.value).toBe(2);
    expect(old.district?.forms.map((f) => f.form)).toEqual(['single-detached']);
  });

  it('rejects a catalogue where a code or alias is ambiguous, or a version is duplicated', () => {
    const clash: ZoningRulesVersion = {
      ...TESTVILLE_2025_01_01,
      districts: [
        ...TESTVILLE_2025_01_01.districts,
        { ...TESTVILLE_2025_01_01.districts[0]!, code: 'TV-X', aliases: ['tv-r1'] },
      ],
    };
    expect(() => createZoningResolver([clash])).toThrow(/maps to both/);
    expect(() => createZoningResolver([TESTVILLE_2025_01_01, TESTVILLE_2025_01_01])).toThrow(/twice/);
  });
});
