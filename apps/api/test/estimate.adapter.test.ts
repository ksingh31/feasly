/**
 * Estimate adapter tests (consumer/03).
 *
 * The adapter is thin by design; these tests pin its two wiring decisions:
 * (1) it runs requests through the DEDICATED estimate pipeline (20/hr/IP +
 * per-tenant aggregation), never the general pipeline; (2) it copies the
 * embed tenantKey from the request body into the pipeline request so the
 * tenant limiter has a key to aggregate on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pipelineRun = vi.fn();
const routeHandle = vi.fn();
const fakeApp = {
  estimatePipeline: { run: pipelineRun },
  estimateRoute: { handle: routeHandle },
  // api-mcp/07: passthrough for adapter tests (no Bearer key in these tests).
  withApiKeyRateLimit: async (
    _headers: unknown,
    _correlationId: string,
    _options: unknown,
    handler: () => Promise<unknown>,
  ) => handler(),
};

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
  loadConfig: () => ({ corsOrigins: [] }),
  middleware: {
    resolveCorsHeaders: () => ({}),
    isPreflight: () => false,
    preflightHeaders: () => ({}),
    ensureCorrelationId: () => 'corr-1',
    isProblemDetails: (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      (value as Record<string, unknown>)['status'] === 429,
    problemResponseHeaders: () => ({ 'Content-Type': 'application/problem+json' }),
    securityHeaders: () => ({}),
  },
}));

// Imported after the mock: the adapter binds `createComposition` lazily via
// getApp(), but the module import itself must see the mocked barrel.
import { estimateHandler } from '../src/functions/estimate';

function context() {
  return { res: undefined as unknown, log: () => {} };
}

beforeEach(() => {
  pipelineRun.mockReset();
  routeHandle.mockReset();
  pipelineRun.mockImplementation(async (request: unknown, handler: () => Promise<unknown>) => handler());
  routeHandle.mockResolvedValue({ estimateId: 'e1' });
});

describe('estimate adapter (consumer/03)', () => {
  it('runs through the dedicated estimate pipeline', async () => {
    const ctx = context();
    await estimateHandler(ctx, {
      headers: { 'x-forwarded-for': '1.2.3.4' },
      body: { address: '123 Main St NW' },
    });
    expect(pipelineRun).toHaveBeenCalledTimes(1);
    const [request] = pipelineRun.mock.calls[0] as [Record<string, unknown>];
    expect(request['clientIp']).toBe('1.2.3.4');
    expect(routeHandle).toHaveBeenCalledTimes(1);
  });

  it('copies a string tenantKey from the body for the tenant limiter', async () => {
    const ctx = context();
    await estimateHandler(ctx, {
      headers: {},
      body: { address: '123 Main St NW', tenantKey: 'elite-craft' },
    });
    const [request] = pipelineRun.mock.calls[0] as [Record<string, unknown>];
    expect(request['tenantKey']).toBe('elite-craft');
  });

  it('leaves tenantKey undefined when the body has none (or a non-string)', async () => {
    const ctx = context();
    await estimateHandler(ctx, { headers: {}, body: { address: '123 Main St NW' } });
    const [request] = pipelineRun.mock.calls[0] as [Record<string, unknown>];
    expect(request['tenantKey']).toBeUndefined();

    pipelineRun.mockClear();
    await estimateHandler(ctx, {
      headers: {},
      body: { address: '123 Main St NW', tenantKey: 42 },
    });
    const [request2] = pipelineRun.mock.calls[0] as [Record<string, unknown>];
    expect(request2['tenantKey']).toBeUndefined();
  });
});
