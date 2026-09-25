/**
 * Azure Functions v3 trigger adapter — POST /mcp/v1.
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

  const app = getApp();
  const headers: Record<string, string | string[] | undefined> = {
    ...(req.headers ?? {}),
  };
  if (!headers[CORRELATION_RESPONSE_HEADER]) {
    headers[CORRELATION_RESPONSE_HEADER] = randomUUID();
  }
  const correlationId = middleware.ensureCorrelationId(headers);

  // Run through the rate limiter (public endpoint, abuse resistance).
  // The MCP route handles auth (Bearer API key) internally.
  const result = await app.requestPipeline.run(
    {
      headers,
      clientIp: clientIpFrom(req),
    },
    () => app.mcpRoute.handle(headers, req.body),
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
