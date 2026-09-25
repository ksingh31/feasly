/**
 * Shared dispatch for the admin-estimates Functions adapters (admin/03).
 *
 * Follows the api-keys/shared.ts adapter pattern: CORS at the edge,
 * composition cached module-level, correlation ID on every response.
 * The route itself enforces the admin session guard; the adapter only
 * needs to pass headers through.
 */
import { randomUUID } from 'node:crypto';
import {
  createComposition,
  loadConfig,
  middleware,
  type AppComposition,
} from '../../index';

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
  query?: Record<string, string | string[] | undefined>;
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

export async function dispatchAdminEstimates(
  context: FunctionContext,
  req: FunctionRequest,
  invoke: (app: AppComposition) => Promise<unknown>,
): Promise<void> {
  const origin = req.headers?.['origin'];
  const corsHeaders = middleware.resolveCorsHeaders(
    origin,
    loadConfig().corsOrigins,
  );
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
    () => invoke(app),
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
      [CORRELATION_RESPONSE_HEADER]: correlationId,
      ...corsHeaders,
    },
    body: result,
  };
}
