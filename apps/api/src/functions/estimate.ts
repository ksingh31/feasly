/**
 * Azure Functions v3 trigger adapter — POST /api/v1/estimate.
 *
 * Thin by design: build the pipeline request from the Functions `req`,
 * run it through the BE0-003 pipeline (correlation + rate limiting +
 * RFC 7807 errors), and translate the outcome to `context.res`.
 *
 * - Imports only from the package public surface (`../index`), never deep
 *   paths — see src/index.ts.
 * - The composition (config, pool, engine) is built once per instance and
 *   cached module-level; the pg pool stays warm across invocations.
 * - Logging uses the pipeline's default console logger: the Functions host
 *   captures console output into Application Insights, and every entry
 *   carries the correlation ID. (A per-request `context.log` can't be bound
 *   to a cached composition, so it is deliberately not injected.)
 * - The correlation ID is derived here and injected into the headers handed
 *   to the pipeline, so the `x-correlation-id` response header always
 *   matches the ID in logs and error bodies.
 * - Bundled by `npm run bundle:functions` into `estimate/index.js`
 *   (self-contained — the Function App has no node_modules).
 */
import { randomUUID } from 'node:crypto';
import {
  createComposition,
  middleware,
  type AppComposition,
} from '../index';

/** Minimal structural types — no @azure/functions dependency needed. */
export interface FunctionContext {
  res?: unknown;
  log: (...args: unknown[]) => void;
}

export interface FunctionRequest {
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

export async function estimateHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
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
    () => app.estimateRoute.handle(req.body),
  );

  if (middleware.isProblemDetails(result)) {
    context.res = {
      status: result.status,
      headers: {
        'Content-Type': 'application/problem+json',
        [CORRELATION_RESPONSE_HEADER]: result.correlationId,
      },
      body: result,
    };
    return;
  }
  context.res = {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      [CORRELATION_RESPONSE_HEADER]: correlationId,
    },
    body: result,
  };
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = estimateHandler;
