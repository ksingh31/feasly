/**
 * Embed session adapter (#795): the response carries a session token, so it
 * must send `Cache-Control: no-store` plus the standard security headers on
 * success, problems and preflight.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as realMiddleware from '../src/middleware';

const pipelineRun = vi.fn();
let problem = false;
const fakeApp = {
  requestPipeline: { run: pipelineRun },
  embedSessionRoute: { handle: vi.fn(async () => ({ token: 't' })) },
};
let preflight = false;

vi.mock('../src/index', async () => {
  const mw = await vi.importActual<typeof import('../src/middleware')>('../src/middleware');
  return {
    createComposition: () => fakeApp,
    loadConfig: () => ({ corsOrigins: [] }),
    middleware: {
      ...mw,
      isPreflight: () => preflight,
      isProblemDetails: () => problem,
    },
  };
});

import { embedSessionHandler } from '../src/functions/embed-session';

type Res = { status: number; headers: Record<string, string> };

beforeEach(() => {
  problem = false;
  preflight = false;
  pipelineRun.mockReset();
  pipelineRun.mockImplementation(async (_r: unknown, h: () => Promise<unknown>) => h());
});

describe('embed session adapter headers', () => {
  it('200 is no-store with security headers', async () => {
    const ctx = { res: undefined as unknown, log: () => {} };
    await embedSessionHandler(ctx, { method: 'POST', headers: {}, body: {} });
    const res = ctx.res as Res;
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject(realMiddleware.securityHeaders());
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('problem responses are no-store', async () => {
    problem = true;
    pipelineRun.mockResolvedValue({ status: 429, code: 'RATE_LIMITED', correlationId: 'c' });
    const ctx = { res: undefined as unknown, log: () => {} };
    await embedSessionHandler(ctx, { method: 'POST', headers: {}, body: {} });
    const res = ctx.res as Res;
    expect(res.status).toBe(429);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('preflight carries the security headers', async () => {
    preflight = true;
    const ctx = { res: undefined as unknown, log: () => {} };
    await embedSessionHandler(ctx, { method: 'OPTIONS', headers: { origin: 'https://x' } });
    const res = ctx.res as Res;
    expect(res.status).toBe(204);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});
