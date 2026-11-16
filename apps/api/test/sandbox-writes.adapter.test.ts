/**
 * #793 — the REST adapters carry the API key's sandbox flag into the write.
 *
 * `withApiKeyRateLimit` authenticates the Bearer key and hands the auth
 * context to the inner handler. The estimate and lead adapters must pass
 * `{ sandbox: true }` to their route when the key is a `feasly_test_` key,
 * and call the route exactly as before for live keys and first-party
 * (keyless) traffic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pipelineRun = vi.fn();
const estimateHandle = vi.fn();
const leadHandle = vi.fn();
/** The auth context the fake middleware hands to the inner handler. */
let currentAuth: { sandbox: boolean } | null = null;

const fakeApp = {
  estimatePipeline: { run: pipelineRun },
  leadPipeline: { run: pipelineRun },
  estimateRoute: { handle: estimateHandle },
  leadRoute: { handle: leadHandle },
  withApiKeyRateLimit: async (
    _headers: unknown,
    _correlationId: string,
    _options: unknown,
    handler: (auth: unknown) => Promise<unknown>,
  ) => handler(currentAuth),
};

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
  loadConfig: () => ({ corsOrigins: [] }),
  middleware: {
    resolveCorsHeaders: () => ({}),
    isPreflight: () => false,
    preflightHeaders: () => ({}),
    ensureCorrelationId: () => 'corr-1',
    isProblemDetails: () => false,
    problemResponseHeaders: () => ({}),
    securityHeaders: () => ({}),
  },
}));

import { estimateHandler } from '../src/functions/estimate';
import { leadsHandler } from '../src/functions/leads';

function context() {
  return { res: undefined as unknown, log: () => {} };
}

const BODY = { any: 'body' };

beforeEach(() => {
  pipelineRun.mockReset();
  estimateHandle.mockReset();
  leadHandle.mockReset();
  pipelineRun.mockImplementation(async (_req: unknown, handler: () => Promise<unknown>) => handler());
  estimateHandle.mockResolvedValue({ estimateId: 'e1' });
  leadHandle.mockResolvedValue({ leadId: 'l1' });
  currentAuth = null;
});

describe('#793 REST adapters — sandbox keys', () => {
  it('estimate: a sandbox key writes with sandbox=true', async () => {
    currentAuth = { sandbox: true };
    await estimateHandler(context(), { headers: {}, body: BODY });
    expect(estimateHandle).toHaveBeenCalledWith(BODY, { sandbox: true });
  });

  it('estimate: a live key and keyless traffic write normal rows', async () => {
    currentAuth = { sandbox: false };
    await estimateHandler(context(), { headers: {}, body: BODY });
    currentAuth = null;
    await estimateHandler(context(), { headers: {}, body: BODY });
    expect(estimateHandle.mock.calls).toEqual([[BODY], [BODY]]);
  });

  it('leads: a sandbox key writes with sandbox=true', async () => {
    currentAuth = { sandbox: true };
    await leadsHandler(context(), { headers: {}, body: BODY });
    expect(leadHandle).toHaveBeenCalledWith(BODY, { sandbox: true });
  });

  it('leads: a live key and keyless traffic write normal rows', async () => {
    currentAuth = { sandbox: false };
    await leadsHandler(context(), { headers: {}, body: BODY });
    currentAuth = null;
    await leadsHandler(context(), { headers: {}, body: BODY });
    expect(leadHandle.mock.calls).toEqual([[BODY], [BODY]]);
  });
});
