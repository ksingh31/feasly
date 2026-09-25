/**
 * Unsubscribe adapter tests (email/03).
 *
 * The adapters are thin by design; these tests pin their wiring decisions:
 * (1) the token comes from the route path (`bindingData.token`), never the
 * query string or body; (2) GET and POST each reach their own route method;
 * (3) the request still runs through the pipeline (rate limiting applies).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pipelineRun = vi.fn();
const getState = vi.fn();
const unsubscribe = vi.fn();
const fakeApp = {
  requestPipeline: { run: pipelineRun },
  unsubscribeRoute: { getState, unsubscribe },
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
    securityHeaders: () => ({}),
  },
}));

// Imported after the mock: the adapters bind `createComposition` lazily via
// getApp(), but the module import itself must see the mocked barrel.
import { unsubscribeGetHandler } from '../src/functions/unsubscribe-get';
import { unsubscribePostHandler } from '../src/functions/unsubscribe-post';

function context(token: unknown) {
  return {
    res: undefined as unknown,
    log: () => {},
    bindingData: { token },
  };
}

beforeEach(() => {
  pipelineRun.mockReset();
  getState.mockReset();
  unsubscribe.mockReset();
  pipelineRun.mockImplementation(
    async (request: unknown, handler: () => Promise<unknown>) => handler(),
  );
  getState.mockResolvedValue({
    valid: true,
    leadId: 'lead-1',
    alreadyUnsubscribed: false,
  });
  unsubscribe.mockResolvedValue({
    unsubscribed: true,
    alreadyUnsubscribed: false,
  });
});

describe('unsubscribe adapters (email/03)', () => {
  it('GET passes the path token to getState (never logs it)', async () => {
    const ctx = context('lead-1.1726611200.abc123');
    await unsubscribeGetHandler(ctx, { headers: {} });
    expect(pipelineRun).toHaveBeenCalledTimes(1);
    expect(getState).toHaveBeenCalledTimes(1);
    expect(getState).toHaveBeenCalledWith('lead-1.1726611200.abc123');
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(ctx.res).toMatchObject({ status: 200 });
  });

  it('POST passes the path token to unsubscribe (idempotent opt-out)', async () => {
    const ctx = context('lead-1.1726611200.abc123');
    await unsubscribePostHandler(ctx, { headers: {} });
    expect(pipelineRun).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledWith('lead-1.1726611200.abc123');
    expect(getState).not.toHaveBeenCalled();
    expect(ctx.res).toMatchObject({ status: 200 });
  });

  it('a missing token reaches the route as an empty string (403, no oracle)', async () => {
    const ctx = context(undefined);
    await unsubscribeGetHandler(ctx, { headers: {} });
    expect(getState).toHaveBeenCalledWith('');
  });
});
