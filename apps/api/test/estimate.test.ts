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
import { expectEstimateResponse, mockCommunityStatsService } from './helpers/mock-community-stats';
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
    setNarrative: async ({
      id,
      narrative,
      generatedAt,
    }: {
      id: string;
      narrative: string;
      generatedAt: Date;
    }) => {
      const rec = byId.get(id);
      if (!rec || rec.narrative) return false;
      byId.set(id, { ...rec, narrative, narrativeGeneratedAt: generatedAt });
      return true;
    },
    findByAddressKey: async (addressKey: string) =>
      [...byId.values()]
        .filter((r) => r.addressKey === addressKey)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  };
}

describe('estimate service', () => {
  it('returns the contracts EstimateResponse shape with the version pin', async () => {
    const store = fakeStore();
    const service = createEstimateService({ costData: PLACEHOLDER_COST_DATA, store, allowDraftCostData: true,
    communityStats: mockCommunityStatsService(),});
    const result = expectEstimateResponse(await service.estimate(VALID_BODY));

    // Contract conformance: exact top-level keys of EstimateResponse.
    expect(Object.keys(result).sort()).toEqual(
      ['addressKey', 'costDataVersion', 'createdAt', 'disclaimer', 'estimateId', 'figures', 'inputs', 'rows'].sort(),
    );
    expect(result.estimateId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.addressKey).toBe('calgary-123-fake-st-nw');
    expect(result.costDataVersion).toBe('v0.3.0-unclibrated');
    expect(result.inputs).toEqual({
      sqft: 2_200,
      tier: 'premium',
      garage: 'none',
      basement: 'unfinished',
    });
    // Contract CostRange is { low, base, high } — the engine's deterministic base is exposed.
    for (const key of ['build', 'total'] as const) {
      expect(Object.keys(result.figures[key]).sort()).toEqual(['base', 'high', 'low']);
      expect(result.figures[key].low).toBeLessThanOrEqual(result.figures[key].base);
      expect(result.figures[key].base).toBeLessThanOrEqual(result.figures[key].high);
    }
    // Land is a FIXED figure equal to the assessed value — never a range.
    expect(result.figures.land).toEqual({ value: 450_000 });
    expect(result.figures.total.low).toBeGreaterThan(0);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(Object.keys(row).sort()).toEqual(['key', 'label', 'range']);
    }
    expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
  });

  it('persists the immutable record before returning', async () => {
    const store = fakeStore();
    const service = createEstimateService({ costData: PLACEHOLDER_COST_DATA, store, allowDraftCostData: true,
    communityStats: mockCommunityStatsService(),});
    const result = expectEstimateResponse(await service.estimate(VALID_BODY));
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
      allowDraftCostData: true,
    communityStats: mockCommunityStatsService(),});
    const error = await service.estimate({ property: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a missing addressKey with 400', async () => {
    const service = createEstimateService({
      costData: PLACEHOLDER_COST_DATA,
      store: fakeStore(),
      allowDraftCostData: true,
    communityStats: mockCommunityStatsService(),});
    const error = await service
      .estimate({
        property: { assessedLandValue: 1, lotSizeSqft: 1, zoning: 'R-C1' },
        scope: { buildSqft: 2_200, tier: 'standard' },
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
  });

  it('rejects the legacy flat new-build body with 400 VALIDATION_FAILED', async () => {
    const service = createEstimateService({
      costData: PLACEHOLDER_COST_DATA,
      store: fakeStore(),
      allowDraftCostData: true,
    communityStats: mockCommunityStatsService(),});
    // Old flat shape: { addressKey, sqft, tier, garage, basement } at top level.
    const error = await service
      .estimate({
        addressKey: 'calgary-123-fake-st-nw',
        sqft: 2_200,
        tier: 'premium',
        garage: 'double',
        basement: 'unfinished',
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a wrong-typed field with 400', async () => {
    const service = createEstimateService({
      costData: PLACEHOLDER_COST_DATA,
      store: fakeStore(),
      allowDraftCostData: true,
    communityStats: mockCommunityStatsService(),});
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
      allowDraftCostData: true,
    communityStats: mockCommunityStatsService(),});
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
      setNarrative: async () => false,
      findByAddressKey: async () => [],
    };
    const service = createEstimateService({ costData: PLACEHOLDER_COST_DATA, store: broken, allowDraftCostData: true,
    communityStats: mockCommunityStatsService(),});
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
      allowDraftCostData: true,
    communityStats: mockCommunityStatsService(),});
    const route = createEstimateRoute({ estimate: service });
    const viaRoute = expectEstimateResponse(await route.handle(VALID_BODY));
    expect(viaRoute.addressKey).toBe('calgary-123-fake-st-nw');
    expect(viaRoute.costDataVersion).toBe('v0.3.0-unclibrated');
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
    expect(outcome.costDataVersion).toBe('v0.3.0-unclibrated');
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
        setNarrative: async () => false,
        findByAddressKey: async () => [],
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

/**
 * Renovation estimate path (RENO-01).
 *
 * Covers the story's API-level acceptance criteria:
 *  - happy paths per reno type (extensive/addition/basement/combined)
 *  - RFC 7807 422s naming the field: bad renoType, negative renoSqft,
 *    missing addressKey (AC7)
 *  - serialized responses leak no per_sqft/margin/param terms (AC6)
 *  - one immutable row per call, pinned to the frozen cost-data version (AC8)
 *  - draft-data gate: 503 without COST_ENGINE_ALLOW_DRAFT, 200 with it
 *  - new-build output shape unchanged (AC5 regression — see the exact-keys
 *    test in 'estimate service' above, which still passes unmodified)
 */
const RENO_BODY = {
  projectType: 'renovation',
  addressKey: 'calgary-456-reno-ave-nw',
  renoType: 'extensive',
  renoSqft: 1_000,
  tier: 'premium',
};

function renoService(allowDraftCostData = true) {
  const store = fakeStore();
  const service = createEstimateService({
    costData: PLACEHOLDER_COST_DATA,
    store,
    allowDraftCostData,
    communityStats: mockCommunityStatsService(),});
  return { service, store };
}

describe('estimate service — renovation', () => {
  it('returns a reno estimate with ranges, rows, assumptions and visibility hints', async () => {
    const { service } = renoService();
    const result = expectEstimateResponse(await service.estimate(RENO_BODY));
    expect(result.projectType).toBe('renovation');
    expect(result.addressKey).toBe('calgary-456-reno-ave-nw');
    expect(result.costDataVersion).toBe('v0.3.0-unclibrated');
    expect(result.figures.build).toEqual({ low: 184_000, base: 230_000, high: 288_000 });
    expect(result.figures.total).toEqual(result.figures.build);
    expect(result.figures.land).toEqual({ value: 0 });
    expect(result.rows.map((r) => r.key)).toEqual(['reno.extensive']);
    expect(result.renoInputs).toEqual({
      projectType: 'renovation',
      renoType: 'extensive',
      renoSqft: 1_000,
      tier: 'premium',
      underpinning: false,
    });
    expect(result.assumptions!.length).toBeGreaterThan(0);
    expect(result.assumptions!.some((a) => a.includes('PLACEHOLDER'))).toBe(true);
    expect(result.visibility).toEqual({ land: 'not_applicable', build: 'blurred', total: 'blurred' });
  });

  it.each([
    ['extensive', ['reno.extensive']],
    ['addition', ['reno.addition']],
    ['basement', ['reno.basement']],
    ['combined', ['reno.extensive', 'reno.addition', 'reno.basement']],
  ] as const)('prices renoType %s with component rows %o', async (renoType, keys) => {
    const { service } = renoService();
    const result = expectEstimateResponse(await service.estimate({ ...RENO_BODY, renoType }));
    expect(result.rows.map((r) => r.key)).toEqual([...keys]);
    expect(result.figures.total.low).toBeLessThanOrEqual(result.figures.total.base);
  });

  it('caps addition billing at 400 sqft', async () => {
    const { service } = renoService();
    const capped = expectEstimateResponse(await service.estimate({ ...RENO_BODY, renoType: 'addition', renoSqft: 600 }));
    const exact = expectEstimateResponse(await service.estimate({ ...RENO_BODY, renoType: 'addition', renoSqft: 400 }));
    expect(capped.figures.total).toEqual(exact.figures.total);
  });

  it('adds the underpinning row for basement when requested', async () => {
    const { service } = renoService();
    const result = expectEstimateResponse(await service.estimate({
      ...RENO_BODY,
      renoType: 'basement',
      renoSqft: 800,
      underpinning: true,
    }));
    expect(result.rows.map((r) => r.key)).toEqual(['reno.basement', 'reno.underpinning']);
    expect(result.renoInputs!.underpinning).toBe(true);
  });

  it('rejects an invalid renoType with 422 naming the field (AC7)', async () => {
    const { service } = renoService();
    const error = await service
      .estimate({ ...RENO_BODY, renoType: 'gut-rehab' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(String(error.message)).toContain('renoType');
  });

  it('rejects a negative renoSqft with 422 naming the field (AC7)', async () => {
    const { service } = renoService();
    const error = await service.estimate({ ...RENO_BODY, renoSqft: -50 }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(422);
    expect(String(error.message)).toContain('renoSqft');
  });

  it('rejects a missing addressKey with 422 naming the field (AC7)', async () => {
    const { service } = renoService();
    const { addressKey: _omitted, ...noAddress } = RENO_BODY;
    const error = await service.estimate(noAddress).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(422);
    expect(String(error.message)).toContain('addressKey');
  });

  it('leaks no per_sqft/margin/param terms in the serialized response (AC6)', async () => {
    const { service } = renoService();
    const result = expectEstimateResponse(await service.estimate({
      ...RENO_BODY,
      renoType: 'combined',
      renoSqft: 600,
      underpinning: true,
    }));
    const serialized = JSON.stringify(result).toLowerCase();
    for (const fragment of ['per_sqft', 'persqft', 'unit_rate', 'margin', 'param']) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it('persists exactly one immutable row per call pinned to the version (AC8)', async () => {
    const { service, store } = renoService();
    const first = expectEstimateResponse(await service.estimate(RENO_BODY));
    const second = expectEstimateResponse(await service.estimate({ ...RENO_BODY, renoType: 'basement' }));
    expect(store.saved).toHaveLength(2);
    for (const [saved, result] of [
      [store.saved[0], first],
      [store.saved[1], second],
    ] as const) {
      expect(saved.id).toBe(result.estimateId);
      expect(saved.projectType).toBe('renovation');
      expect(saved.costDataVersion).toBe('v0.3.0-unclibrated');
      expect(saved.addressKey).toBe(result.addressKey);
    }
    expect(store.saved[0].id).not.toBe(store.saved[1].id);
  });

  it('refuses reno on draft data without the flag (503)', async () => {
    const { service } = renoService(false);
    const error = await service.estimate(RENO_BODY).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(503);
  });

  it('still serves new_build on draft data without the flag', async () => {
    const { service } = renoService(false);
    const result = expectEstimateResponse(await service.estimate(VALID_BODY));
    expect(result.addressKey).toBe('calgary-123-fake-st-nw');
    expect(result.projectType).toBeUndefined();
  });
});

describe('renovation through the request pipeline (PGlite-backed stores)', () => {
  let testDb: TestDb;
  let app: AppComposition;

  const DRAFT_ENV = {
    ...TEST_ENV,
    COST_ENGINE_ALLOW_DRAFT: 'true',
  } as NodeJS.ProcessEnv;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createComposition(DRAFT_ENV, {
      estimateStore: createDrizzleEstimateStore({ db: testDb.db }),
    });
  }, 60_000);
  afterAll(async () => {
    await app.db.close();
    await testDb.close();
  });

  it('persists a renovation row with project_type=renovation and serves it back', async () => {
    const outcome = await app.requestPipeline.run(
      { headers: {}, clientIp: '127.0.0.4' },
      () =>
        app.estimateRoute.handle({
          projectType: 'renovation',
          addressKey: 'calgary-789-pipeline-rd-nw',
          renoType: 'basement',
          renoSqft: 800,
          tier: 'standard',
          underpinning: true,
        }),
    );
    expect(isProblemDetails(outcome)).toBe(false);
    if (!isProblemDetails(outcome)) {
      const body = outcome as unknown as { estimateId: string; projectType: string };
      expect(body.projectType).toBe('renovation');
      const record = await app.estimateStore.findById(body.estimateId);
      expect(record).not.toBeNull();
      expect(record!.projectType).toBe('renovation');
      expect(record!.costDataVersion).toBe('v0.3.0-unclibrated');
    }
  });

  it('returns RFC 7807 for an invalid reno body', async () => {
    const outcome = await app.requestPipeline.run(
      { headers: {}, clientIp: '127.0.0.5' },
      () =>
        app.estimateRoute.handle({
          projectType: 'renovation',
          addressKey: 'calgary-789-pipeline-rd-nw',
          renoType: 'nope',
          renoSqft: 800,
          tier: 'standard',
        }),
    );
    expect(isProblemDetails(outcome)).toBe(true);
    if (isProblemDetails(outcome)) {
      expect(outcome.status).toBe(422);
      expect(outcome.code).toBe('VALIDATION_FAILED');
      expect(String(outcome.detail)).toContain('renoType');
    }
  });
});
