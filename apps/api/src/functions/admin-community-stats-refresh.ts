/**
 * Azure Functions v3 trigger adapter — POST /api/v1/admin/community-stats/refresh.
 *
 * Thin by design: build the pipeline request from the Functions `req`,
 * run it through the BE0-003 pipeline (correlation + rate limiting +
 * RFC 7807 errors), and translate the outcome to `context.res`.
 *
 * - Imports only from the package public surface (`../index`), never deep
 *   paths — see src/index.ts.
 * - The composition (config, pool, engine) is built once per instance and
 *   cached module-level; the pg pool stays warm across invocations.
 * - Admin authentication is enforced inside the route via the AdminGuard
 *   (currently the interim pre-shared-key guard; admin/01 swaps in
 *   session auth). The guard runs INSIDE the pipeline so failures get the
 *   uniform RFC 7807 envelope.
 * - Bundled by `npm run bundle:functions` into
 *   `admin-community-stats-refresh/index.js` (self-contained — the
 *   Function App has no node_modules).
 */
import { randomUUID } from 'node:crypto';
import {
  createComposition,
  loadConfig,
  middleware,
  type AppComposition,
} from '../index';

/** Minimal structural types — no @azure/functions dependency needed. */
export interface FunctionContext {
  res?: unknown;
  log: (...args: unknown[]) => void;
  /** Route parameters from the httpTrigger binding (v3 programming model). */
  bindingData?: Record<string, unknown>;
}

export interface FunctionRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

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

export async function adminCommunityStatsRefreshHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
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

  const result = await app.requestPipeline.run(
    { headers, clientIp: clientIpFrom(req) },
    () => app.communityStatsRefreshRoute.trigger(headers),
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
      [CORRELATION_RESPONSE_HEADER]: correlationId,
      ...corsHeaders,
    },
    body: result,
  };
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminCommunityStatsRefreshHandler;
