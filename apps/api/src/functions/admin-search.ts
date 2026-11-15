/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/search.
 *
 * Admin ⌘K global search. Same edge shape as admin-users/shared.ts (CORS,
 * cached composition, correlation ID, registry-enforced permissions) but
 * runs through the dedicated `adminSearchPipeline` (per-IP limiter first,
 * then per admin session) — a palette fires per keystroke and must not eat
 * the general API budget.
 *
 * Bundled by `npm run bundle:functions` into `admin-search/index.js`.
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
}

export interface FunctionRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}

const CORRELATION_RESPONSE_HEADER = 'x-correlation-id';
const REGISTRY_PATH = '/api/v1/admin/search';

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

export async function adminSearchHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const origin = req.headers?.['origin'];
  const corsHeaders = middleware.resolveCorsHeaders(origin, loadConfig().corsOrigins);
  if (middleware.isPreflight(req.method, origin)) {
    context.res = {
      status: 204,
      headers: {
        ...middleware.securityHeaders(),
        ...corsHeaders,
        ...middleware.preflightHeaders(),
      },
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

  const result = await app.adminSearchPipeline.run(
    { headers, clientIp: clientIpFrom(req) },
    async () => {
      await middleware.enforceRoutePermissions(
        app.permissionGuard,
        req.method,
        REGISTRY_PATH,
        headers,
      );
      return app.adminSearchRoute.search(headers, req.query ?? {});
    },
  );

  if (middleware.isProblemDetails(result)) {
    context.res = {
      status: result.status,
      headers: {
        ...middleware.securityHeaders(),
        'Content-Type': 'application/problem+json',
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
      // Search results contain PII — never cache them.
      'Cache-Control': 'no-store',
      [CORRELATION_RESPONSE_HEADER]: correlationId,
      ...corsHeaders,
    },
    body: result,
  };
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminSearchHandler;
