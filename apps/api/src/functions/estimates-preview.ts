/**
 * Azure Functions v3 trigger adapter — POST /api/v1/estimates/preview.
 *
 * Same adapter pattern as `estimate.ts`: CORS at the edge, correlation ID,
 * then the BE0-003 pipeline. Runs on the dedicated estimates pipeline
 * (consumer/03 — 20/hr per IP + per-tenant aggregation) with the same
 * api-key wrapper as the canonical estimate endpoint, since it runs the
 * same deterministic engine. The return type is the contracts
 * `PreviewEstimateResponse` (real computed figures — UI renders them
 * blurred pre-gate — and empty rows) — the narrowing is type-enforced
 * in the preview service, not here.
 *
 * Bundled by `npm run bundle:functions` into `estimates-preview/index.js`
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

export async function estimatesPreviewHandler(
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

  // Same pipeline as the canonical estimate endpoint: the preview runs the
  // same engine at the same cost, so it shares the 20/hr/IP budget. The
  // tenantKey is copied from the body for the rate-limit key only.
  const rawBody =
    typeof req.body === 'object' && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  const result = await app.estimatePipeline.run(
    {
      headers,
      clientIp: clientIpFrom(req),
      tenantKey:
        typeof rawBody.tenantKey === 'string' ? rawBody.tenantKey : undefined,
    },
    () =>
      app.withApiKeyRateLimit(
        headers,
        correlationId,
        {
          endpoint: '/api/v1/estimates/preview',
          extractEstimateId: (r) =>
            typeof r === 'object' && r !== null && 'estimateId' in r
              ? String((r as { estimateId: unknown }).estimateId)
              : undefined,
        },
        () => app.previewRoute.handle(req.body),
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
module.exports = estimatesPreviewHandler;
