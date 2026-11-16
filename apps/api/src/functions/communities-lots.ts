/**
 * Azure Functions v3 trigger adapter — GET /api/v1/communities/{slug}/lots.
 *
 * Thin by design: build the pipeline request from the Functions `req`,
 * run it through the BE0-003 pipeline (correlation + rate limiting +
 * RFC 7807 errors), and translate the outcome to `context.res`.
 *
 * - Public endpoint (#691): one page of an established community's listed
 *   lots (vacant residential parcels from City open data). Rate-limited
 *   like other public reads (pipeline limiter).
 * - Cached: the inventory changes weekly, so 200s carry
 *   `Cache-Control: public, max-age=<COMMUNITY_LOTS_CACHE_MAX_AGE_S>`.
 *   Problems are never cached.
 * - Imports only from the package public surface (`../index`).
 * - Bundled by `npm run bundle:functions` into `communities-lots/index.js`.
 */
import { randomUUID } from 'node:crypto';
import {
  createComposition,
  loadConfig,
  middleware,
  type AppComposition,
} from '../index';
import type {
  FunctionContext,
  FunctionRequest,
} from './communities-stats';
import { clientIpFromHeaders } from '../middleware/client-ip';

const CORRELATION_RESPONSE_HEADER = 'x-correlation-id';

let cached: AppComposition | undefined;

function getApp(): AppComposition {
  if (!cached) cached = createComposition();
  return cached;
}

/** #729: right-most (platform-appended) X-Forwarded-For hop — see middleware/client-ip.ts. */
function clientIpFrom(req: FunctionRequest): string | undefined {
  return clientIpFromHeaders(req.headers);
}

export async function communitiesLotsHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  // HRD-01: CORS is enforced at the adapter edge. The preflight path uses
  // config alone — the full composition is never loaded for an OPTIONS
  // request. Non-allowlisted origins get no Access-Control-Allow-Origin
  // (fail-closed).
  const origin = req.headers?.['origin'];
  const corsHeaders = middleware.resolveCorsHeaders(origin, loadConfig().corsOrigins);
  if (middleware.isPreflight(req.method, origin)) {
    context.res = {
      status: 204,
      headers: { ...middleware.securityHeaders(), ...corsHeaders, ...middleware.preflightHeaders() },
    };
    return;
  }

  const app = getApp();
  const headers: Record<string, string | string[] | undefined> = {
    ...(req.headers ?? {}),
  };
  if (!headers[CORRELATION_RESPONSE_HEADER]) {
    headers[CORRELATION_RESPONSE_HEADER] = randomUUID();
  }
  const correlationId = middleware.ensureCorrelationId(headers);
  const slug = context.bindingData?.['slug'];

  const result = await app.requestPipeline.run(
    { headers, clientIp: clientIpFrom(req), method: req.method },
    () => app.communityLotsRoute.handle(slug, req.query),
  );

  if (middleware.isProblemDetails(result)) {
    context.res = {
      status: result.status,
      headers: {
        ...middleware.securityHeaders(),
        ...middleware.problemResponseHeaders(result),
        [CORRELATION_RESPONSE_HEADER]: result.correlationId,
        ...corsHeaders,
      },
      body: result,
    };
    return;
  }
  context.res = {
    status: 200,
    headers: {
      ...middleware.securityHeaders(),
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${app.config.communityLots.cacheMaxAgeSeconds}`,
      [CORRELATION_RESPONSE_HEADER]: correlationId,
      ...corsHeaders,
    },
    body: result,
  };
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = communitiesLotsHandler;
