/**
 * Estimate service + route tests (BE-3).
 *
 * Covers: happy-path estimate returning the contracts `EstimateResponse`
 * shape with the version pin, persistence of the immutable record, Zod shape
 * rejection, engine bound rejection mapped to 400, store failures surfacing
 * as generic 500s through the pipeline (no leak), route delegation to the
 * service interface, and end-to-end runs through the BE0-003 request pipeline
 * (correlation + RFC 7807 error format).
 *
 * Service unit tests fake the store at the interface boundary. Pipeline
 * tests run the real Drizzle stores against PGlite (real SQL, no network).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import { createComposition, type AppComposition } from '../src/composition';
import { createEstimateRoute } from '../src/routes/estimate.route';
import { createEstimateService } from '../src/services/estimate.service';
import {
  createDrizzleEstimateStore,
  type EstimateRecord,
  type EstimateStore,
} from '../src/services/estimate.store';
import { HttpError, isProblemDetails } from '../src/middleware/errors';
import { createTestDb, type TestDb } from './pglite-db';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@localhost:5432/feasly_test',
} as NodeJS.ProcessEnv;

const VALID_BODY = {
  property: {
    addressKey: 'calgary-123-fake-st-nw',
    assessedLandValue: 450_000,
    lotSizeSqft: 5_000,
    zoning: 'R-C1',
  },
  scope: { buildSqft: 2_200, tier: 'premium' },
};

/** In-memory fake of the EstimateStore interface. */
function fakeStore(): EstimateStore & { saved: EstimateRecord[] } {
  const saved: EstimateRecord[] = [];
  const byId = new Map<string, EstimateRecord>();
  return {
    saved,
    save: async (record: EstimateRecord) => {
      saved.push(record);
      byId.set(record.id, record);
    },
    findById: async (id: string) => byId.get(id) ?? null,
  };
}

describe('estimate service', () => {
  it('returns the contracts EstimateResponse shape with the version pin', async () => {
    const store = fakeStore();
    const service = createEstimateService({ costData: PLACEHOLDER_COST_DATA, store });
    const result = await service.estimate(VALID_BODY);

    // Contract conformance: exact top-level keys of EstimateResponse.
    expect(Object.keys(result).sort()).toEqual(
      ['addressKey', 'costDataVersion', 'createdAt', 'estimateId', 'figures', 'inputs', 'rows'].sort(),
    );
    expect(result.estimateId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.addressKey).toBe('calgary-123-fake-st-nw');
    expect(result.costDataVersion).toBe('v0.1.0-unclibrated');
    expect(result.inputs).toEqual({
      sqft: 2_200,
      tier: 'premium',
      garage: 'none',
      basement: 'unfinished',
    });
    // Contract CostRange is { low, high } — the engine's base is not exposed.
    for (const key of ['build', 'total', 'land'] as const) {
      expect(Object.keys(result.figures[key]).sort()).toEqual(['high', 'low']);
      expect(result.figures[key].low).toBeLessThanOrEqual(result.figures[key].high);
    }
    expect(result.figures.total.low).toBeGreaterThan(0);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(Object.keys(row).sort()).toEqual(['key', 'label', 'range']);
    }
    expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
  });

  it('persists the immutable record before returning', async () => {
    const store = fakeStore();
    const service = createEstimateService({ costData: PLACEHOLDER_COST_DATA, store });
    const result = await service.estimate(VALID_BODY);
    expect(store.saved).toHaveLength(1);
    const saved = store.saved[0];
    expect(saved.id).toBe(result.estimateId);
    expect(saved.addressKey).toBe(result.addressKey);
    expect(saved.costDataVersion).toBe(result.costDataVersion);
    expect(saved.inputs).toEqual(result.inputs);
    expect(saved.figures).toEqual(result.figures);
  });

  it('rejects a malformed body with 400 VALIDATION_FAILED', async () => {
    const service = createEstimateService({
      costData: PLACEHOLDER_COST_DATA,
      store: fakeStore(),
    });
    const error = await service.estimate({ property: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a missing addressKey with 400', async () => {
    const service = createEstimateService({
      costData: PLACEHOLDER_COST_DATA,
      store: fakeStore(),
    });
    const error = await service
      .estimate({
        property: { assessedLandValue: 1, lotSizeSqft: 1, zoning: 'R-C1' },
        scope: { buildSqft: 2_200, tier: 'standard' },
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
  });

  it('rejects a wrong-typed field with 400', async () => {
    const service = createEstimateService({
      costData: PLACEHOLDER_COST_DATA,
      store: fakeStore(),
    });
    const error = await service
      .estimate({ ...VALID_BODY, scope: { buildSqft: 'lots', tier: 'premium' } })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
  });

  it('maps engine bound violations to 400 (not 500)', async () => {
    const service = createEstimateService({
      costData: PLACEHOLDER_COST_DATA,
      store: fakeStore(),
    });
    const error = await service
      .estimate({ ...VALID_BODY, scope: { buildSqft: 50_000, tier: 'standard' } })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('propagates store failures (pipeline turns them into generic 500s)', async () => {
    const broken: EstimateStore = {
      save: async () => {
        throw new Error('connection refused: secrets must not leak');
      },
      findById: async () => null,
    };
    const service = createEstimateService({ costData: PLACEHOLDER_COST_DATA, store: broken });
    const error = await service.estimate(VALID_BODY).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpError);
  });
});

describe('estimate route', () => {
  it('delegates to the service interface', async () => {
    const service = createEstimateService({
      costData: PLACEHOLDER_COST_DATA,
      store: fakeStore(),
    });
    const route = createEstimateRoute({ estimate: service });
    const viaRoute = await route.handle(VALID_BODY);
    expect(viaRoute.addressKey).toBe('calgary-123-fake-st-nw');
    expect(viaRoute.costDataVersion).toBe('v0.1.0-unclibrated');
  });
});

describe('estimate through the request pipeline (PGlite-backed stores)', () => {
  let testDb: TestDb;
  let app: AppComposition;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createComposition(TEST_ENV, {
      estimateStore: createDrizzleEstimateStore({ db: testDb.db }),
    });
  }, 60_000);
  afterAll(async () => {
    await app.db.close();
    await testDb.close();
  });

  it('returns the estimate for a valid body and persists it', async () => {
    const outcome = await app.requestPipeline.run(
      { headers: {}, clientIp: '127.0.0.1' },
      () => app.estimateRoute.handle(VALID_BODY),
    );
    if (isProblemDetails(outcome)) throw new Error(`unexpected problem: ${outcome.title}`);
    expect(outcome.costDataVersion).toBe('v0.1.0-unclibrated');
    expect(outcome.estimateId).toBeDefined();
    const persisted = await app.estimateStore.findById(outcome.estimateId);
    expect(persisted?.addressKey).toBe('calgary-123-fake-st-nw');
  });

  it('returns RFC 7807 problem details (400) for an invalid body', async () => {
    const outcome = await app.requestPipeline.run(
      { headers: {}, clientIp: '127.0.0.2' },
      () => app.estimateRoute.handle({ nope: true }),
    );
    expect(isProblemDetails(outcome)).toBe(true);
    if (isProblemDetails(outcome)) {
      expect(outcome.status).toBe(400);
      expect(outcome.code).toBe('VALIDATION_FAILED');
      expect(outcome.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('returns a generic 500 without leaking internals when the store fails', async () => {
    const brokenApp = createComposition(TEST_ENV, {
      estimateStore: {
        save: async () => {
          throw new Error('connection refused: pg password hunter2');
        },
        findById: async () => null,
      },
    });
    try {
      const outcome = await brokenApp.requestPipeline.run(
        { headers: {}, clientIp: '127.0.0.3' },
        () => brokenApp.estimateRoute.handle(VALID_BODY),
      );
      expect(isProblemDetails(outcome)).toBe(true);
      if (isProblemDetails(outcome)) {
        expect(outcome.status).toBe(500);
        expect(outcome.code).toBe('INTERNAL_ERROR');
        expect(JSON.stringify(outcome)).not.toContain('hunter2');
        expect(JSON.stringify(outcome)).not.toContain('connection refused');
      }
    } finally {
      await brokenApp.db.close();
    }
  });
});
