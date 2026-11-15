/**
 * Zoning districts adapter (#687): public GET runs through the pipeline
 * (rate limiting), returns the route's catalogue, and is cacheable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pipelineRun = vi.fn();
const handle = vi.fn();
let problem = false;
const fakeApp = {
  requestPipeline: { run: pipelineRun },
  zoningRoute: { handle },
  config: { zoning: { city: 'calgary', cacheMaxAgeSeconds: 1234 } },
};

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
  loadConfig: () => ({ corsOrigins: [] }),
  middleware: {
    resolveCorsHeaders: () => ({}),
    isPreflight: () => false,
    preflightHeaders: () => ({}),
    ensureCorrelationId: () => 'corr-1',
    isProblemDetails: () => problem,
    problemResponseHeaders: () => ({}),
    securityHeaders: () => ({}),
  },
}));

import { zoningDistrictsHandler } from '../src/functions/zoning-districts';

const CATALOGUE = {
  city: 'calgary',
  effectiveDate: '2026-08-04',
  bylaw: 'Land Use Bylaw 1P2007',
  bylawVersion: 'x',
  sourceUrl: 'https://www.calgary.ca/',
  districts: [],
};

beforeEach(() => {
  problem = false;
  pipelineRun.mockReset();
  handle.mockReset();
  pipelineRun.mockImplementation(async (_req: unknown, h: () => Promise<unknown>) => h());
  handle.mockResolvedValue(CATALOGUE);
});

describe('zoning districts adapter', () => {
  it('200 with the catalogue and a public Cache-Control from config', async () => {
    const ctx = { res: undefined as unknown, log: () => {} };
    await zoningDistrictsHandler(ctx, { method: 'GET', headers: {} });
    expect(pipelineRun).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(ctx.res).toMatchObject({
      status: 200,
      body: CATALOGUE,
      headers: { 'Cache-Control': 'public, max-age=1234', 'Content-Type': 'application/json' },
    });
  });

  it('problems are passed through and never cached', async () => {
    problem = true;
    pipelineRun.mockResolvedValue({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', correlationId: 'c' });
    const ctx = { res: undefined as unknown, log: () => {} };
    await zoningDistrictsHandler(ctx, { method: 'GET', headers: {} });
    const res = ctx.res as { status: number; headers: Record<string, string> };
    expect(res.status).toBe(503);
    expect(res.headers['Cache-Control']).toBeUndefined();
  });
});
