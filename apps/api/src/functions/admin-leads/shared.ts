/**
 * Shared dispatch for the admin-leads Functions adapters (admin/02).
 *
 * Follows the api-keys/shared.ts adapter pattern: CORS at the edge,
 * composition cached module-level, correlation ID on every response.
 * Admin authentication is enforced inside the route via the session-cookie
 * AdminGuard (admin/01).
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

export async function dispatchAdminLeads(
  context: FunctionContext,
  req: FunctionRequest,
  invoke: (app: AppComposition) => Promise<unknown>,
  opts?: {
    /** When true, the result is raw CSV text (not JSON). */
    readonly csv?: boolean;
    /** Filename for the Content-Disposition header (CSV exports). */
    readonly filename?: string;
  },
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

  if (opts?.csv === true && typeof result === 'object' && result !== null) {
    const { csv, filename } = result as {
      readonly csv: string;
      readonly filename: string;
    };
    context.res = {
      status: 200,
      headers: {
        ...middleware.securityHeaders(),
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename ?? opts.filename ?? 'leads.csv'}"`,
        [CORRELATION_RESPONSE_HEADER]: correlationId,
        ...corsHeaders,
      },
      body: csv,
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
