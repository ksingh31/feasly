/**
 * Azure Functions v3 trigger adapter — POST /api/v1/leads.
 *
 * Same adapter pattern as `estimate.ts`, with two deliberate differences:
 *  1. It runs through `leadPipeline`, which carries the dedicated tight rate
 *     limiter for the public lead gate (the gate is unauthenticated by
 *     design — abuse resistance comes from the limiter).
 *  2. It never logs the request body: the body carries PII (name, email,
 *     phone). The pipeline logger only ever sees service error messages,
 *     which reference field paths, never values.
 *
 * Bundled by `npm run bundle:functions` into `leads/index.js`
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

export async function leadsHandler(
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

  const rawBody =
    typeof req.body === 'object' && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  const result = await app.leadPipeline.run(
    {
      headers,
      clientIp: clientIpFrom(req),
      tenantKey:
        typeof rawBody.tenantKey === 'string' ? rawBody.tenantKey : undefined,
    },
    // The body is never logged — see module docstring.
    // api-mcp/07 — per-key rate limiting + usage metering when a Bearer
    // API key is present.
    () =>
      app.withApiKeyRateLimit(
        headers,
        correlationId,
        { endpoint: '/api/v1/leads' },
        () => app.leadRoute.handle(req.body),
      ),
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
    // HRD-03: lead capture returns 201 — including honeypot-trapped
    // submissions, which are quarantined server-side but answer identically
    // so bots learn nothing.
    status: 201,
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
module.exports = leadsHandler;
