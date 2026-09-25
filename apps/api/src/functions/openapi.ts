/**
 * Azure Functions v3 trigger adapter — GET /api/v1/openapi.json.
 *
 * Serves the generated OpenAPI 3.1 spec (api-mcp/03). Public by design —
 * no auth, no rate limiting (it's a static document). The spec is generated
 * from the zod schemas at request time (cheap — it's a pure function of
 * config), ensuring it always reflects the deployed version.
 *
 * - Imports only from the package public surface (`../index`), never deep
 *   paths — see src/index.ts.
 * - The composition is built once per instance and cached module-level.
 * - Bundled by `npm run bundle:functions` into `openapi/index.js`
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
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

const CORRELATION_RESPONSE_HEADER = 'x-correlation-id';

let cached: AppComposition | undefined;

function getApp(): AppComposition {
  if (!cached) cached = createComposition();
  return cached;
}

export async function openApiHandler(
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

  // Public endpoint — no auth, no rate limiting. The spec is a pure
  // function of config (siteUrl, version), so it's always current.
  const spec = await app.openApiRoute.handle();

  context.res = {
    status: 200,
    headers: {
      ...middleware.securityHeaders(),
      'Content-Type': 'application/json',
      // Cache for 1 hour — the spec changes only on deploy.
      'Cache-Control': 'public, max-age=3600',
      [CORRELATION_RESPONSE_HEADER]: correlationId,
    },
    body: spec,
  };
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = openApiHandler;
