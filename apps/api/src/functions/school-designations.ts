/**
 * Azure Functions v3 trigger adapter — GET /api/v1/school-designations?addressKey= (#775).
 *
 * Thin by design: build the pipeline request from the Functions `req`, run
 * it through the BE0-003 pipeline (correlation + rate limiting + RFC 7807
 * errors), and translate the outcome to `context.res`.
 *
 * - Public, free, ungated: typically designated schools via the address's
 *   community. Reads our tables (and the shared property cache, #756).
 * - Imports only from the package public surface (`../index`).
 * - Bundled by `npm run bundle:functions` into `school-designations/index.js`.
 */
import { randomUUID } from 'node:crypto';
import { createComposition, loadConfig, middleware, type AppComposition } from '../index';
import type { FunctionContext, FunctionRequest } from './communities-stats';
import { clientIpFromHeaders } from '../middleware/client-ip';

const CORRELATION_RESPONSE_HEADER = 'x-correlation-id';

let cached: AppComposition | undefined;

function getApp(): AppComposition {
  if (!cached) cached = createComposition();
  return cached;
}

export async function schoolDesignationsHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  // HRD-01: CORS at the adapter edge; preflight never loads the composition.
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
  const headers: Record<string, string | string[] | undefined> = { ...(req.headers ?? {}) };
  if (!headers[CORRELATION_RESPONSE_HEADER]) headers[CORRELATION_RESPONSE_HEADER] = randomUUID();
  const correlationId = middleware.ensureCorrelationId(headers);

  const result = await app.requestPipeline.run(
    { headers, clientIp: clientIpFromHeaders(req.headers), method: req.method },
    () => app.schoolDesignationsRoute.address(req.query),
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
module.exports = schoolDesignationsHandler;
