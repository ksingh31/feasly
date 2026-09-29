/**
 * Shared dispatch for the lead-comments Functions adapters (BILL-05).
 *
 * One parameterized dispatcher serves all four adapters instead of
 * four copies of the same boilerplate:
 * - `builder-lead-comments` (GET/POST /api/v1/builder/leads/{leadId}/comments)
 * - `builder-comment` (PATCH /api/v1/builder/comments/{commentId})
 * - `admin-lead-comments` (GET/POST /api/v1/admin/leads/{leadId}/comments)
 * - `admin-comment` (PATCH/DELETE /api/v1/admin/comments/{commentId})
 *
 * Guard handling follows the existing features:
 * - builder adapters require a valid builder session at dispatch time
 *   (same as builder-leads), in addition to the route-level check.
 * - admin adapters rely on the route-level AdminGuard (same as
 *   admin-builders).
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

export async function dispatchComments(
  context: FunctionContext,
  req: FunctionRequest,
  invoke: (app: AppComposition) => Promise<unknown>,
  opts: {
    /**
     * auth/04: registry path (e.g. '/api/v1/builder/leads/{leadId}/comments').
     * The route's registry `permissions` are enforced before the route runs.
     */
    readonly path: string;
    /**
     * 'builder' requires a builder session at dispatch time (in addition
     * to the route-level check); 'admin' defers to the route's AdminGuard.
     */
    readonly guard: 'builder' | 'admin';
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

  // Builder endpoints require a valid builder session (mirrors builder-leads).
  if (opts.guard === 'builder') {
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
    async () => {
      // auth/04: registry permissions are REAL authorization — enforced
      // here, centrally, before the route runs.
      await middleware.enforceRoutePermissions(
        app.permissionGuard,
        req.method,
        opts.path,
        headers,
      );
      return invoke(app);
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
      [CORRELATION_RESPONSE_HEADER]: correlationId,
      ...corsHeaders,
    },
    body: result,
  };
}
