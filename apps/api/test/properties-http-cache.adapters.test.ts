/**
 * Property GET adapters — HTTP caching (#756).
 *
 * Lookup and autocomplete answer 200 with `ETag` + `Cache-Control: public,
 * max-age=<PROPERTY_HTTP_CACHE_MAX_AGE_S>`, and 304 (no body) when
 * `If-None-Match` names the current representation. Problem responses keep
 * the default `no-store`.
 */
import { describe, expect, it, vi } from 'vitest';
import * as realMiddleware from '../src/middleware';

const passthroughPipeline = {
  async run(_request: unknown, handler: () => Promise<unknown>) {
    try {
      return await handler();
    } catch (error) {
      return realMiddleware.toProblemDetails(error, 'corr-1');
    }
  },
};

const RECORD = { addressKey: '2032 42 AV SW', assessedValue: 840_500 };
const lookup = vi.fn(async (addressKey: unknown) => {
  if (addressKey === 'missing') {
    throw new realMiddleware.HttpError(404, realMiddleware.ErrorCodes.ADDRESS_NOT_FOUND, 'nope', false);
  }
  return RECORD;
});
const autocomplete = vi.fn(async () => ({ suggestions: [] }));

const fakeApp = {
  requestPipeline: passthroughPipeline,
  propertyRoute: { autocomplete, lookup },
  withApiKeyRateLimit: (_h: unknown, _c: unknown, _o: unknown, fn: () => Promise<unknown>) => fn(),
  config: { propertyData: { httpCacheMaxAgeSeconds: 900 } },
};

vi.mock('../src/index', async () => ({
  createComposition: () => fakeApp,
  loadConfig: () => ({ corsOrigins: [] }),
  middleware: await vi.importActual('../src/middleware'),
  lib: await vi.importActual('../src/lib'),
}));

import { propertiesLookupHandler } from '../src/functions/properties-lookup';
import { propertiesAutocompleteHandler } from '../src/functions/properties-autocomplete';

interface Res {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}
type Handler = (ctx: { res?: unknown; log: () => void }, req: Record<string, unknown>) => Promise<void>;

async function call(handler: Handler, req: Record<string, unknown>): Promise<Res> {
  const ctx: { res?: unknown; log: () => void } = { log: () => {} };
  await handler(ctx, { method: 'GET', ...req });
  return ctx.res as Res;
}

const CASES: ReadonlyArray<{ name: string; handler: Handler; query: Record<string, string> }> = [
  { name: 'lookup', handler: propertiesLookupHandler as unknown as Handler, query: { addressKey: 'k' } },
  {
    name: 'autocomplete',
    handler: propertiesAutocompleteHandler as unknown as Handler,
    query: { q: '2032 42' },
  },
];

describe('property GET adapters — HTTP caching (#756)', () => {
  for (const c of CASES) {
    it(`${c.name}: 200 carries ETag + public Cache-Control from config`, async () => {
      const res = await call(c.handler, { query: c.query, headers: {} });
      expect(res.status).toBe(200);
      expect(res.headers['Cache-Control']).toBe('public, max-age=900');
      expect(res.headers['ETag']).toMatch(/^W\/"/);
      expect(res.body).toBeDefined();
    });

    it(`${c.name}: matching If-None-Match → 304 without a body`, async () => {
      const first = await call(c.handler, { query: c.query, headers: {} });
      const res = await call(c.handler, {
        query: c.query,
        headers: { 'if-none-match': first.headers['ETag'] },
      });
      expect(res.status).toBe(304);
      expect(res.body).toBeUndefined();
      expect(res.headers['ETag']).toBe(first.headers['ETag']);
      expect(res.headers['Cache-Control']).toBe('public, max-age=900');
    });

    it(`${c.name}: stale If-None-Match → 200 with the body`, async () => {
      const res = await call(c.handler, {
        query: c.query,
        headers: { 'if-none-match': 'W/"stale"' },
      });
      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
    });
  }

  it('problem responses stay no-store and carry no ETag', async () => {
    const res = await call(propertiesLookupHandler as unknown as Handler, {
      query: { addressKey: 'missing' },
      headers: {},
    });
    expect(res.status).toBe(404);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['ETag']).toBeUndefined();
  });
});
