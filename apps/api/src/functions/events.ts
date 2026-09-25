/**
 * Azure Functions v3 trigger adapter — POST /api/v1/events.
 *
 * Same adapter pattern as `leads.ts`:
 *  1. It runs through `analyticsPipeline`, which carries the dedicated
 *     300/min per-IP rate limiter for public analytics ingest (the endpoint
 *     is unauthenticated by design — first-party analytics; abuse resistance
 *     comes from the limiter).
 *  2. It never logs the request body — the pipeline logger only ever sees
 *     service error messages, which reference field paths, never values.
 *
 * Bundled by `npm run bundle:functions` into `events/index.js`
 * (self-contained — the Function App has no node_modules).
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

export async function eventsHandler(
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

  const result = await app.analyticsPipeline.run(
    {
      headers,
      clientIp: clientIpFrom(req),
    },
    // The body is never logged — see module docstring.
    () => app.analyticsRoute.handle(req.body),
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
    // Analytics ingest is fire-and-forget: 202 Accepted, echoing the stored
    // contract-shaped event so the client can confirm consent_ts round-trip.
    status: 202,
    headers: {
      ...middleware.securityHeaders(),
      'Content-Type': 'application/json',
      [CORRELATION_RESPONSE_HEADER]: correlationId,
      ...corsHeaders,
    },
    body: result,
  };
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = eventsHandler;
