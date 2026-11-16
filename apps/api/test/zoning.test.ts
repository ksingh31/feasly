/**
 * Zoning rules catalogue — service, route, schema (issue #687).
 *
 * AC1: every registered catalogue validates against the zod schema.
 * AC3: unverified values are absent from the endpoint response.
 * AC5: the response passes the OpenAPI response schema (contract
 *      conformance) and carries city / effectiveDate / sourceUrl.
 * AC6: a second city is data + config only (fixture city, no code change).
 * AC7: no dollar figure in the response.
 */
import { describe, expect, it } from 'vitest';
import type { ZoningDistrictsResponse, ZoningRulesVersion } from '@feasly/contracts';
import { CALGARY_2026_08_04, ZONING_CATALOGUES, createZoningResolver } from '@feasly/zoning';
import { HttpError } from '../src/middleware/errors';
import {
  ZoningDistrictsResponseSchema,
  ZoningRulesVersionSchema,
} from '../src/openapi/schemas';
import { createZoningRoute } from '../src/routes/zoning.route';
import { createZoningService, type ZoningService } from '../src/services/zoning.service';

const FIXTURE_CITY: ZoningRulesVersion = {
  city: 'testville',
  effectiveDate: '2026-01-01',
  bylaw: 'Testville Zoning Bylaw',
  bylawVersion: 'Original text',
  sourceUrl: 'https://testville.example/zoning',
  districts: [
    {
      code: 'TV-1',
      name: 'Testville One',
      category: 'low-density',
      coverage: 'covered',
      forms: [
        { form: 'single-detached', permission: 'permitted', section: '§ 1', verified: true },
        { form: 'duplex', permission: 'discretionary', section: '§ 2', verified: false },
      ],
      rules: {
        maxHeightM: { value: 9, section: '§ 3', verified: true },
        maxDensityUnitsPerHa: { value: 40, section: '§ 4', verified: false },
      },
    },
  ],
};

describe('catalogue data validates against the zod schema (AC1)', () => {
  it.each(ZONING_CATALOGUES.map((c) => [`${c.city}/${c.effectiveDate}`, c] as const))(
    '%s',
    (_name, catalogue) => {
      const parsed = ZoningRulesVersionSchema.safeParse(catalogue);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 5))).toBe(true);
    },
  );

  it('the fixture city validates too', () => {
    expect(ZoningRulesVersionSchema.safeParse(FIXTURE_CITY).success).toBe(true);
  });

  it('a malformed entry fails (unknown form, missing verified flag)', () => {
    const bad = {
      ...FIXTURE_CITY,
      districts: [
        {
          ...FIXTURE_CITY.districts[0],
          forms: [{ form: 'castle', permission: 'permitted', section: '§ 1' }],
        },
      ],
    };
    expect(ZoningRulesVersionSchema.safeParse(bad).success).toBe(false);
  });
});

describe('zoning service', () => {
  it('serves the configured city (default catalogues)', () => {
    const svc = createZoningService({ config: { city: 'calgary' } });
    const cat = svc.getCatalogue();
    expect(cat?.city).toBe('calgary');
    expect(cat?.effectiveDate).toBe(CALGARY_2026_08_04.effectiveDate);
    expect(svc.resolve('r-c1s').district?.code).toBe('R-C1s');
    expect(svc.resolve('nope').status).toBe('unknown');
  });

  it('a second city is data + config only (AC6)', () => {
    const resolver = createZoningResolver([...ZONING_CATALOGUES, FIXTURE_CITY]);
    const svc = createZoningService({ config: { city: 'testville' }, resolver });
    const cat = svc.getCatalogue();
    expect(cat?.city).toBe('testville');
    expect(cat?.districts.map((d) => d.code)).toEqual(['TV-1']);
    // Unverified duplex + density are dropped (AC3).
    expect(cat?.districts[0]?.forms.map((f) => f.form)).toEqual(['single-detached']);
    expect(cat?.districts[0]?.rules).toEqual({ maxHeightM: { value: 9, section: '§ 3' } });
    expect(ZoningDistrictsResponseSchema.safeParse(cat).success).toBe(true);
  });

  it('unknown configured city → no catalogue', () => {
    expect(createZoningService({ config: { city: 'atlantis' } }).getCatalogue()).toBeUndefined();
  });
});

describe('GET /api/v1/zoning/districts route (AC5)', () => {
  const route = createZoningRoute({ zoning: createZoningService({ config: { city: 'calgary' } }) });

  it('returns the catalogue with city, effectiveDate, sourceUrl', async () => {
    const res: ZoningDistrictsResponse = await route.handle();
    expect(res.city).toBe('calgary');
    expect(res.effectiveDate).toBe('2026-08-04');
    expect(res.sourceUrl).toMatch(/^https:\/\/www\.calgary\.ca\//);
    expect(res.districts.find((d) => d.code === 'R-CG')?.rules.maxDensityUnitsPerHa?.value).toBe(75);
  });

  it('#689: lists the forms the cost engine can estimate (single-detached only today)', async () => {
    expect((await route.handle()).estimableBuildingForms).toEqual(['single-detached']);
  });

  it('conforms to the OpenAPI response schema (strict: no extra keys)', async () => {
    const parsed = ZoningDistrictsResponseSchema.safeParse(await route.handle());
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 5))).toBe(true);
  });

  it('never includes an unverified value or a verified flag (AC3)', async () => {
    const body = JSON.stringify(await route.handle());
    expect(body).not.toContain('verified');
    const rcg = (await route.handle()).districts.find((d) => d.code === 'R-CG');
    // R-CG height/coverage are unverified (reported 2026 amendment).
    expect(rcg?.rules.maxHeightM).toBeUndefined();
    expect(rcg?.rules.maxLotCoveragePct).toBeUndefined();
  });

  it('has no dollar figures (AC7)', async () => {
    const body = JSON.stringify(await route.handle());
    expect(body).not.toMatch(/\$\s?\d|CA\$|"(cost|price|amount|cents)[A-Za-z]*"\s*:/i);
  });

  it('503 DEPENDENCY_UNAVAILABLE (not retryable) when the city has no catalogue', async () => {
    const empty: ZoningService = {
      getCatalogue: () => undefined,
      resolve: () => ({ status: 'unknown', requestedCode: '' }),
    };
    const err = await createZoningRoute({ zoning: empty }).handle().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', retryable: false });
  });
});
