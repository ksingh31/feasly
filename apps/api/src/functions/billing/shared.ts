/**
 * Shared dispatch for the billing Functions adapters (billing/01).
 *
 * Unlike the builder-leads dispatch, this does NOT require a session
 * upfront: the billing endpoints mix builder auth (report-contract,
 * dispute, get) and admin auth (resolve), so each route enforces its own
 * guard. Everything else (CORS, correlation id, problem-details mapping)
 * mirrors the builder-leads dispatch.
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

/** #729: right-most (platform-appended) X-Forwarded-For hop — see middleware/client-ip.ts. */
function clientIpFrom(req: FunctionRequest): string | undefined {
  return clientIpFromHeaders(req.headers);
}

export async function dispatchBilling(
  context: FunctionContext,
  req: FunctionRequest,
  invoke: (app: AppComposition) => Promise<unknown>,
  opts?: {
  /**
   * auth/04: registry path (e.g. '/api/v1/admin/leads'). When set, the
   * route's registry `permissions` are enforced before the route runs.
   * Adapters pass this; the registry is the single source of truth.
   */
  readonly path?: string;
  /**
   * #661: the result is `{ pdf: Buffer, filename }` — sent as raw
   * `application/pdf` bytes with an attachment Content-Disposition.
   */
  readonly pdf?: boolean;
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
    { headers, clientIp: clientIpFrom(req), method: req.method },
    async () => {
      // auth/04: registry permissions are REAL authorization — enforced
      // here, centrally, before the route runs.
      if (opts?.path) {
        await middleware.enforceRoutePermissions(
          app.permissionGuard,
          req.method,
          opts.path,
          headers,
        );
      }
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

  if (opts?.pdf === true && typeof result === 'object' && result !== null) {
    const { pdf, filename } = result as {
      readonly pdf: Buffer;
      readonly filename: string;
    };
    context.res = {
      status: 200,
      headers: {
        ...middleware.securityHeaders(),
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
        [CORRELATION_RESPONSE_HEADER]: correlationId,
        ...corsHeaders,
      },
      // v3 model: isRaw keeps the Buffer as bytes (no JSON serialization).
      isRaw: true,
      body: pdf,
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
