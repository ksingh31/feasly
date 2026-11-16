/**
 * Azure Functions v3 trigger adapter — POST /api/mcp/v1.
 *
 * Streamable HTTP transport for the MCP server (api-mcp/06).
 * Thin by design: authenticate via the MCP route (Bearer API key),
 * run the MCP protocol, translate the outcome to `context.res`.
 *
 * - Imports only from the package public surface (`../index`), never deep
 *   paths — see src/index.ts.
 * - The composition (config, pool, engine) is built once per instance and
 *   cached module-level; the pg pool stays warm across invocations.
 * - Stateless transport mode: each request creates a fresh MCP server +
 *   transport (serverless-friendly, no session persistence).
 * - Bundled by `npm run bundle:functions` into `mcp/index.js`
 *   (self-contained — the Function App has no node_modules).
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
import { hasMultipleToolCalls, isMeteredMcpBody } from '../middleware/mcp-metering';

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

export async function mcpHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  // CORS is enforced at the adapter edge. The preflight path uses
  // config alone — the full composition (DB pool, rate limiters) is never
  // loaded for an OPTIONS request.
  const origin = req.headers?.['origin'];
  const corsHeaders = middleware.resolveCorsHeaders(origin, loadConfig().corsOrigins);
  if (middleware.isPreflight(req.method, origin)) {
    context.res = {
      status: 204,
      headers: { ...middleware.securityHeaders(), ...corsHeaders, ...middleware.preflightHeaders() },
    };
    return;
  }

  // Only POST is supported (Streamable HTTP).
  if (req.method !== 'POST') {
    context.res = {
      status: 405,
      headers: {
        ...middleware.securityHeaders(),
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
      body: {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Only POST is supported for the MCP endpoint.',
        },
      },
    };
    return;
  }

  // #738: a batch of several tools/call would count as one metered request
  // and so multiply the key's quota; reject it before any pipeline work.
  if (hasMultipleToolCalls(req.body)) {
    context.res = {
      status: 400,
      headers: {
        ...middleware.securityHeaders(),
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
      body: {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Batches with more than one tools/call are not supported. Send one call per request.',
        },
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

  // Run through the rate limiter (public endpoint, abuse resistance).
  // #738: a Bearer key also passes the per-key limiter — per-minute
  // window plus the daily/monthly quota — and every accepted call is
  // metered in api_usage like the REST endpoints. The authenticated key is
  // handed to the route so it isn't looked up twice; without a Bearer
  // header the route answers its own JSON-RPC 401.
  const result = await app.requestPipeline.run(
    {
      headers,
      clientIp: clientIpFrom(req),
      method: req.method,
    },
    () =>
      app.withApiKeyRateLimit(
        headers,
        correlationId,
        {
          endpoint: '/api/mcp/v1',
          // MCP gates scopes per tool inside the route (#802).
          requiredScope: null,
          // #738: only tool calls count against the quota — protocol
          // housekeeping (initialize, tools/list, notifications) is free.
          metered: isMeteredMcpBody(req.body),
        },
        (auth) => app.mcpRoute.handle(headers, req.body, auth ?? undefined),
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
    status: result.status,
    headers: {
      ...middleware.securityHeaders(),
      ...result.headers,
      [CORRELATION_RESPONSE_HEADER]: correlationId,
      ...corsHeaders,
    },
    body: result.body,
  };
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = mcpHandler;
