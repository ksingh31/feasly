/**
 * Community lots adapter (#691): public GET runs through the pipeline
 * (rate limiting), passes the slug + query to the route, and 200s are
 * cacheable; problems are never cached.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pipelineRun = vi.fn();
const handle = vi.fn();
let problem = false;
const fakeApp = {
  requestPipeline: { run: pipelineRun },
  communityLotsRoute: { handle },
  config: { communityLots: { cacheMaxAgeSeconds: 900 } },
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

import { communitiesLotsHandler } from '../src/functions/communities-lots';

const BODY = { community: { slug: 'altadore', name: 'ALTADORE' }, lots: [], nextCursor: null };

beforeEach(() => {
  problem = false;
  pipelineRun.mockReset();
  handle.mockReset();
  pipelineRun.mockImplementation(async (_req: unknown, h: () => Promise<unknown>) => h());
  handle.mockResolvedValue(BODY);
});

describe('communities lots adapter', () => {
  it('200 with the page and a public Cache-Control from config', async () => {
    const ctx = { res: undefined as unknown, log: () => {}, bindingData: { slug: 'altadore' } };
    await communitiesLotsHandler(ctx, { method: 'GET', headers: {}, query: { sort: 'lot-size-desc' } });
    expect(pipelineRun).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith('altadore', { sort: 'lot-size-desc' });
    expect(ctx.res).toMatchObject({
      status: 200,
      body: BODY,
      headers: { 'Cache-Control': 'public, max-age=900', 'Content-Type': 'application/json' },
    });
  });

  it('problems are passed through and never cached', async () => {
    problem = true;
    pipelineRun.mockResolvedValue({ status: 404, code: 'COMMUNITY_NOT_FOUND', correlationId: 'c' });
    const ctx = { res: undefined as unknown, log: () => {}, bindingData: { slug: 'nowhere' } };
    await communitiesLotsHandler(ctx, { method: 'GET', headers: {} });
    const res = ctx.res as { status: number; headers: Record<string, string> };
    expect(res.status).toBe(404);
    expect(res.headers['Cache-Control']).toBeUndefined();
  });
});
