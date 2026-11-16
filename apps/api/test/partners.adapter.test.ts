/**
 * Partners adapter (#888): public GET runs through the pipeline (rate
 * limiting), returns the route's partner list, and is cacheable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pipelineRun = vi.fn();
const handle = vi.fn();
let problem = false;
const fakeApp = {
  requestPipeline: { run: pipelineRun },
  partnersRoute: { list: handle },
  config: { partners: { cacheTtlMs: 0, cacheMaxAgeSeconds: 1234 } },
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

import { partnersHandler } from '../src/functions/partners';

const CATALOGUE = {
  partners: [
    {
      id: '3fc7bb9f-e00b-4028-9255-e01730fd17c9',
      name: 'Elite Craft Builders',
      logoUrl: null,
      websiteUrl: 'https://elitecraftbuilders.com',
      description: null,
    },
  ],
};

beforeEach(() => {
  problem = false;
  pipelineRun.mockReset();
  handle.mockReset();
  pipelineRun.mockImplementation(async (_req: unknown, h: () => Promise<unknown>) => h());
  handle.mockResolvedValue(CATALOGUE);
});

describe('partners adapter', () => {
  it('200 with the partner list and a public Cache-Control from config', async () => {
    const ctx = { res: undefined as unknown, log: () => {} };
    await partnersHandler(ctx, { method: 'GET', headers: {} });
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
    await partnersHandler(ctx, { method: 'GET', headers: {} });
    const res = ctx.res as { status: number; headers: Record<string, string> };
    expect(res.status).toBe(503);
    expect(res.headers['Cache-Control']).toBeUndefined();
  });
});
