/**
 * Shared dispatch for the audit viewer / finance export / builder activity
 * Functions adapters (#728).
 *
 * Follows the admin-leads/shared.ts adapter pattern: CORS at the edge,
 * composition cached module-level, correlation ID on every response, and
 * the route's registry permissions enforced centrally before the route
 * runs. CSV exports run through the dedicated `financeExportPipeline`
 * (per-IP limiter first, then per session); JSON reads use the general
 * request pipeline.
 */
import { randomUUID } from 'node:crypto';
import {
  createComposition,
  loadConfig,
  middleware,
  type AppComposition,
} from '../../index';
import { clientIpFromHeaders } from '../../middleware/client-ip';

/** Minimal structural types — no @azure/functions dependency needed. */
export interface FunctionContext {
  res?: unknown;
  log: (...args: unknown[]) => void;
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

export async function dispatchAuditFinance(
  context: FunctionContext,
  req: FunctionRequest,
  invoke: (
    app: AppComposition,
    headers: Record<string, string | string[] | undefined>,
  ) => Promise<unknown>,
  opts: {
    /** Registry path — its `permissions` are enforced before the route. */
    readonly path: string;
    /** When true, the result is `{ csv, filename }` sent as text/csv. */
    readonly csv?: boolean;
  },
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
  const pipeline = opts.csv ? app.financeExportPipeline : app.requestPipeline;

  const result = await pipeline.run(
    { headers, clientIp: clientIpFromHeaders(req.headers) },
    async () => {
      await middleware.enforceRoutePermissions(
        app.permissionGuard,
        req.method,
        opts.path,
        headers,
      );
      return invoke(app, headers);
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

  if (opts.csv === true) {
    const { csv, filename } = result as { readonly csv: string; readonly filename: string };
    context.res = {
      status: 200,
      headers: {
        ...middleware.securityHeaders(),
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        // Financial data — never cached by browsers or proxies.
        'Cache-Control': 'no-store',
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
      'Cache-Control': 'no-store',
      [CORRELATION_RESPONSE_HEADER]: correlationId,
      ...corsHeaders,
    },
    body: result,
  };
}
