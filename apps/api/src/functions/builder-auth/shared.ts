/**
 * Shared dispatch for the builder-auth Functions adapters (embed/09).
 *
 * Follows the admin-auth/shared.ts adapter pattern: CORS at the edge,
 * composition cached module-level, correlation ID on every response.
 * Additionally handles the `Set-Cookie` header for session establishment
 * (verify) and clearing (logout) — the route returns it as `setCookie`.
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

export async function dispatchBuilderAuth(
  context: FunctionContext,
  req: FunctionRequest,
  invoke: (app: AppComposition) => Promise<unknown>,
  opts?: { readonly requireAuth?: boolean },
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

  // Authenticated endpoints (e.g. /me) require a valid session before
  // invoking the route. Public endpoints (request, verify) skip this.
  if (opts?.requireAuth === true) {
    try {
      await app.builderGuard.requireBuilder(headers);
    } catch (e) {
      const problem = middleware.toProblemDetails(e, correlationId);
      context.res = {
        status: problem.status,
        headers: {
          ...middleware.securityHeaders(),
          'Content-Type': 'application/problem+json',
          [CORRELATION_RESPONSE_HEADER]: problem.correlationId,
          ...corsHeaders,
        },
        body: problem,
      };
      return;
    }
  }

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

  // The verify/logout routes return `setCookie` for the session cookie.
  // `sessionToken` (verify) is stripped from the JSON body — it travels
  // only in the Set-Cookie header, never as JSON.
  const record =
    typeof result === 'object' && result !== null
      ? (result as Record<string, unknown>)
      : null;
  const setCookie =
    record !== null && typeof record['setCookie'] === 'string'
      ? (record['setCookie'] as string)
      : undefined;
  const body =
    record !== null && (setCookie !== undefined || 'sessionToken' in record)
      ? (({ setCookie: _s, sessionToken: _t, ...rest }) => rest)(record)
      : result;

  context.res = {
    status: 200,
    headers: {
      ...middleware.securityHeaders(),
      'Content-Type': 'application/json',
      [CORRELATION_RESPONSE_HEADER]: correlationId,
      ...(setCookie ? { 'Set-Cookie': setCookie } : {}),
      ...corsHeaders,
    },
    body,
  };
}
