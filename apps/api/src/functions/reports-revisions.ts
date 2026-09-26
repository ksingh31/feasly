/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/reports/{reportToken}/revisions.
 *
 * Same adapter pattern as `reports-get.ts`, plus the request body (the
 * tier/sqft what-if). A revision recomputes through the deterministic
 * engine, so it runs on the dedicated estimates pipeline (consumer/03 —
 * 20/hr per IP, frozen registry). The report token arrives as a path param
 * and is NEVER logged (PII-grade Bearer <redacted>).
 *
 * Bundled by `npm run bundle:functions` into `reports-revisions/index.js`
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

/** Azure Functions v3 surfaces route params on req.params. */
interface ReportFunctionRequest extends FunctionRequest {
  params?: Record<string, string | undefined>;
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

export async function reportsRevisionsHandler(
  context: FunctionContext,
  req: ReportFunctionRequest,
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

  // The path param is never logged — it is the Bearer <redacted>
  // Revisions are engine recomputes: same 20/hr/IP budget as estimates.
  const reportToken = req.params?.reportToken ?? '';
  const result = await app.estimatePipeline.run(
    { headers, clientIp: clientIpFrom(req) },
    () => app.reportRoute.createRevision(reportToken, req.body),
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
module.exports = reportsRevisionsHandler;
