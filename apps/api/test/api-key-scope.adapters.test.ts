/**
 * #802: every REST endpoint that accepts a Bearer API key enforces the
 * key's scopes, not just the MCP tools.
 *
 * Drives each real Functions adapter with the REAL per-key middleware
 * (only the composition is swapped — no database, engine or City API).
 * A key missing the endpoint's scope gets 403 FORBIDDEN and the route is
 * never called; a key with it reaches the route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as realMiddleware from '../src/middleware';
import { createApiKeyRateLimitMiddleware } from '../src/middleware/api-key-rate-limit';
import type { ApiKeyRecord, ApiKeyService } from '../src/services/api-key.service';
import type { UsageService } from '../src/services/usage.service';

function keyRecord(scopes: string[]): ApiKeyRecord {
  return {
    id: `key-${scopes.join('-') || 'none'}`,
    name: 'Scope test key',
    tenantId: null,
    keyPrefix: 'feasly_live_…test',
    scopes,
    rateLimitPerMin: 1000,
    sandbox: false,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
  };
}

const KEYS: Record<string, ApiKeyRecord> = {
  'key-property': keyRecord(['property:read']),
  'key-estimate': keyRecord(['estimate']),
  'key-lead': keyRecord(['lead']),
  'key-none': keyRecord([]),
};

const apiKeys = {
  async authenticate(token: string) {
    const record = KEYS[token];
    if (!record) {
      throw new realMiddleware.HttpError(
        401,
        realMiddleware.ErrorCodes.INVALID_API_KEY,
        'Invalid API key.',
        false,
      );
    }
    return record;
  },
} as unknown as ApiKeyService;

const usage = {
  async checkRateLimit(_keyId: string, limit: number) {
    return { allowed: true, limit, remaining: limit, resetEpoch: 0 };
  },
  async recordUsage() {},
} as unknown as UsageService;

/** Pipeline stand-in: converts thrown HttpErrors to ProblemDetails, like the real one. */
const passthroughPipeline = {
  async run(_request: unknown, handler: () => Promise<unknown>) {
    try {
      return await handler();
    } catch (error) {
      return realMiddleware.toProblemDetails(error, 'corr-1');
    }
  },
};

const routes = {
  estimate: vi.fn(async () => ({ estimateId: 'e1' })),
  preview: vi.fn(async () => ({ estimateId: 'p1' })),
  lead: vi.fn(async () => ({ leadId: 'l1' })),
  autocomplete: vi.fn(async () => ({ suggestions: [] })),
  lookup: vi.fn(async () => ({ addressKey: 'k' })),
  assessment: vi.fn(async () => ({ property: { addressKey: 'k' }, history: [] })),
};

const fakeApp = {
  estimatePipeline: passthroughPipeline,
  leadPipeline: passthroughPipeline,
  requestPipeline: passthroughPipeline,
  estimateRoute: { handle: routes.estimate },
  previewRoute: { handle: routes.preview },
  leadRoute: { handle: routes.lead },
  propertyRoute: {
    autocomplete: routes.autocomplete,
    lookup: routes.lookup,
    assessment: routes.assessment,
  },
  config: { propertyData: { httpCacheMaxAgeSeconds: 60 } },
  withApiKeyRateLimit: createApiKeyRateLimitMiddleware({
    apiKeys,
    usage,
    logger: () => {},
  }),
};

vi.mock('../src/index', async () => ({
  createComposition: () => fakeApp,
  loadConfig: () => ({ corsOrigins: [] }),
  middleware: await vi.importActual('../src/middleware'),
  lib: await vi.importActual('../src/lib'),
}));

// Imported after the mock so each adapter sees the fake composition.
import { estimateHandler } from '../src/functions/estimate';
import { estimatesPreviewHandler } from '../src/functions/estimates-preview';
import { leadsHandler } from '../src/functions/leads';
import { propertiesAutocompleteHandler } from '../src/functions/properties-autocomplete';
import { propertiesLookupHandler } from '../src/functions/properties-lookup';
import { propertiesAssessmentHandler } from '../src/functions/properties-assessment';

type Handler = (ctx: { res?: unknown; log: () => void }, req: Record<string, unknown>) => Promise<void>;

interface Case {
  readonly name: string;
  readonly handler: Handler;
  readonly route: keyof typeof routes;
  readonly allowedKey: string;
  readonly wrongKeys: readonly string[];
  readonly okStatus: number;
  readonly req: Record<string, unknown>;
}

const CASES: readonly Case[] = [
  {
    name: 'POST /api/v1/estimate',
    handler: estimateHandler as unknown as Handler,
    route: 'estimate',
    allowedKey: 'key-estimate',
    wrongKeys: ['key-property', 'key-lead', 'key-none'],
    okStatus: 200,
    req: { method: 'POST', body: { address: '123 Main St NW' } },
  },
  {
    name: 'POST /api/v1/estimates/preview',
    handler: estimatesPreviewHandler as unknown as Handler,
    route: 'preview',
    allowedKey: 'key-estimate',
    wrongKeys: ['key-property', 'key-lead', 'key-none'],
    okStatus: 200,
    req: { method: 'POST', body: { address: '123 Main St NW' } },
  },
  {
    name: 'POST /api/v1/leads',
    handler: leadsHandler as unknown as Handler,
    route: 'lead',
    allowedKey: 'key-lead',
    wrongKeys: ['key-property', 'key-estimate', 'key-none'],
    okStatus: 201,
    req: { method: 'POST', body: { email: 'a@example.com' } },
  },
  {
    name: 'GET /api/v1/properties/autocomplete',
    handler: propertiesAutocompleteHandler as unknown as Handler,
    route: 'autocomplete',
    allowedKey: 'key-property',
    wrongKeys: ['key-estimate', 'key-lead', 'key-none'],
    okStatus: 200,
    req: { method: 'GET', query: { q: '123 Main' } },
  },
  {
    name: 'GET /api/v1/properties/lookup',
    handler: propertiesLookupHandler as unknown as Handler,
    route: 'lookup',
    allowedKey: 'key-property',
    wrongKeys: ['key-estimate', 'key-lead', 'key-none'],
    okStatus: 200,
    req: { method: 'GET', query: { addressKey: 'k' } },
  },
  {
    name: 'GET /api/v1/properties/assessment',
    handler: propertiesAssessmentHandler as unknown as Handler,
    route: 'assessment',
    allowedKey: 'key-property',
    wrongKeys: ['key-estimate', 'key-lead', 'key-none'],
    okStatus: 200,
    req: { method: 'GET', query: { addressKey: 'k' } },
  },
];

function run(c: Case, token: string | null) {
  const ctx: { res?: unknown; log: () => void } = { log: () => {} };
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  return c.handler(ctx, { ...c.req, headers }).then(
    () => ctx.res as { status: number; body: Record<string, unknown> },
  );
}

beforeEach(() => {
  for (const fn of Object.values(routes)) fn.mockClear();
});

describe('#802: REST endpoints enforce API-key scopes', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      for (const wrong of c.wrongKeys) {
        it(`${wrong} → 403 FORBIDDEN, route not called`, async () => {
          const res = await run(c, wrong);
          expect(res.status).toBe(403);
          expect(res.body['code']).toBe('FORBIDDEN');
          expect(routes[c.route]).not.toHaveBeenCalled();
        });
      }

      it(`${c.allowedKey} → reaches the route`, async () => {
        const res = await run(c, c.allowedKey);
        expect(res.status).toBe(c.okStatus);
        expect(routes[c.route]).toHaveBeenCalledTimes(1);
      });

      it('no Bearer key (first-party) → reaches the route', async () => {
        const res = await run(c, null);
        expect(res.status).toBe(c.okStatus);
        expect(routes[c.route]).toHaveBeenCalledTimes(1);
      });
    });
  }
});
