/**
 * Azure Functions v3 trigger adapter — POST /api/v1/waitlist.
 *
 * Same adapter pattern as `callbacks.ts`: CORS at the edge, correlation ID,
 * then the dedicated lead pipeline (10/min per IP — a waitlist signup is a
 * PII-carrying public mutation, same sensitivity class as the lead gate).
 * The body carries an email address and is never logged.
 *
 * Bundled by `npm run bundle:functions` into `waitlist/index.js`
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
import { clientIpFromHeaders } from '../middleware/client-ip';

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

export async function waitlistHandler(
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

  // The body is never logged — it carries the signup email.
  const result = await app.leadPipeline.run(
    { headers, clientIp: clientIpFrom(req) },
    () => app.waitlistRoute.handle(req.body),
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
module.exports = waitlistHandler;
