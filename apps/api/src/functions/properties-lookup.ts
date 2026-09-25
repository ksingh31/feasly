/**
 * Azure Functions v3 trigger adapter — GET /api/v1/properties/lookup.
 *
 * Thin by design: build the pipeline request from the Functions `req`,
 * run it through the BE0-003 pipeline (correlation + rate limiting +
 * RFC 7807 errors), and translate the outcome to `context.res`.
 *
 * - Imports only from the package public surface (`../index`), never deep
 *   paths — see src/index.ts.
 * - The composition (config, pool, engine) is built once per instance and
 *   cached module-level; the pg pool stays warm across invocations.
 * - The correlation ID is derived here and injected into the headers handed
 *   to the pipeline, so the `x-correlation-id` response header always
 *   matches the ID in logs and error bodies.
 * - Bundled by `npm run bundle:functions` into `properties-lookup/index.js`
 *   (self-contained — the Function App has no node_modules).
 */
import { randomUUID } from 'node:crypto';
import {
  createComposition,
  loadConfig,
  middleware,
  type AppComposition,
} from '../index';
import type { FunctionContext, FunctionRequest } from './estimate';

const CORRELATION_RESPONSE_HEADER = 'x-correlation-id';

let cached: AppComposition | undefined;

function getApp(): AppComposition {
  if (!cached) cached = createComposition();
  return cached;
}

function clientIpFrom(req: FunctionRequest): string | undefined {
  const forwarded = req.headers?.['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = first?.split(',')[0]?.trim();
  return ip ? ip : undefined;
}

export async function propertiesLookupHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  // HRD-01: CORS is enforced at the adapter edge. The preflight path uses
  // config alone — the full composition (DB pool, rate limiters) is never
  // loaded for an OPTIONS request. Non-allowlisted origins get no
  // Access-Control-Allow-Origin (fail-closed).
  const origin = req.headers?.['origin'];
  const corsHeaders = middleware.resolveCorsHeaders(origin, loadConfig().corsOrigins);
  if (middleware.isPreflight(req.method, origin)) {
    context.res = {
      status: 204,
      headers: { ...corsHeaders, ...middleware.preflightHeaders() },
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
  const addressKey = req.query?.['addressKey'];

  const result = await app.requestPipeline.run(
    { headers, clientIp: clientIpFrom(req) },
    // api-mcp/07 — per-key rate limiting + usage metering when a Bearer
    // API key is present.
    () =>
      app.withApiKeyRateLimit(
        headers,
        correlationId,
        { endpoint: '/api/v1/properties/lookup' },
        () => app.propertyRoute.lookup(addressKey),
      ),
  );

  if (middleware.isProblemDetails(result)) {
    context.res = {
      status: result.status,
      headers: {
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
      'Content-Type': 'application/json',
      [CORRELATION_RESPONSE_HEADER]: correlationId,
      ...corsHeaders,
    },
    body: result,
  };
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = propertiesLookupHandler;
