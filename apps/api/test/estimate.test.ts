/**
 * Estimate service + route tests (BE0-004).
 *
 * Covers: happy-path estimate with the version pin, Zod shape rejection,
 * engine bound rejection mapped to 400, route delegation to the service
 * interface, composition wiring, and end-to-end runs through the BE0-003
 * request pipeline (correlation + RFC 7807 error format).
 */
import { describe, expect, it } from 'vitest';
import { createComposition } from '../src/composition';
import { createEstimateRoute } from '../src/routes/estimate.route';
import { createEstimateService } from '../src/services/estimate.service';
import { PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import { HttpError } from '../src/middleware/errors';
import { isProblemDetails } from '../src/middleware/errors';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@localhost:5432/feasly_test',
} as NodeJS.ProcessEnv;

const VALID_BODY = {
  property: { assessedLandValue: 450_000, lotSizeSqft: 5_000, zoning: 'R-C1' },
  scope: { buildSqft: 2_200, tier: 'premium' },
};

describe('estimate service', () => {
  const service = createEstimateService({ costData: PLACEHOLDER_COST_DATA });

  it('returns an estimate with the pinned cost-data version', async () => {
    const result = await service.estimate(VALID_BODY);
    expect(result.costDataVersion).toBe('v0.1.0-unclibrated');
    expect(result.calibrated).toBe(false);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.totals.total.base).toBeGreaterThan(0);
  });

  it('rejects a malformed body with 400 VALIDATION_FAILED', async () => {
    const error = await service.estimate({ property: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a wrong-typed field with 400', async () => {
    const error = await service
      .estimate({ ...VALID_BODY, scope: { buildSqft: 'lots', tier: 'premium' } })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
  });

  it('maps engine bound violations to 400 (not 500)', async () => {
    const error = await service
      .estimate({ ...VALID_BODY, scope: { buildSqft: 50_000, tier: 'standard' } })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
  });
});

describe('estimate route', () => {
  it('delegates to the service interface', async () => {
    const service = createEstimateService({ costData: PLACEHOLDER_COST_DATA });
    const route = createEstimateRoute({ estimate: service });
    const viaRoute = await route.handle(VALID_BODY);
    const viaService = await service.estimate(VALID_BODY);
    expect(viaRoute).toEqual(viaService);
  });
});

describe('composition wiring', () => {
  it('resolves the estimate service and route (none undefined)', () => {
    const app = createComposition(TEST_ENV);
    expect(app.estimateService).toBeDefined();
    expect(app.estimateRoute).toBeDefined();
  });
});

describe('estimate through the request pipeline', () => {
  it('returns the estimate for a valid body', async () => {
    const app = createComposition(TEST_ENV);
    const outcome = await app.requestPipeline.run(
      { headers: {}, clientIp: '127.0.0.1' },
      () => app.estimateRoute.handle(VALID_BODY),
    );
    if (isProblemDetails(outcome)) throw new Error(`unexpected problem: ${outcome.title}`);
    expect(outcome.costDataVersion).toBe('v0.1.0-unclibrated');
  });

  it('returns RFC 7807 problem details (400) for an invalid body', async () => {
    const app = createComposition(TEST_ENV);
    const outcome = await app.requestPipeline.run(
      { headers: {}, clientIp: '127.0.0.1' },
      () => app.estimateRoute.handle({ nope: true }),
    );
    expect(isProblemDetails(outcome)).toBe(true);
    if (isProblemDetails(outcome)) {
      expect(outcome.status).toBe(400);
      expect(outcome.code).toBe('VALIDATION_FAILED');
      expect(outcome.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
