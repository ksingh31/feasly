/**
 * Azure Functions v3 trigger adapter — GET /api/health.
 *
 * Replaces the old static stub with the real composition health check
 * (HRD-06): liveness plus dependency state (Postgres). A sick database
 * yields `degraded` with HTTP 200 — never a 500 — so monitors can
 * distinguish "API down" from "API up, database sick".
 *
 * - Imports only from the package public surface (`../index`), never deep
 *   paths — see src/index.ts.
 * - The composition (config, pool) is built once per instance and cached
 *   module-level; the pg pool stays warm across invocations.
 * - Deliberately NOT run through the rate-limited request pipeline: a
 *   health probe must never get a 429 during a traffic spike.
 * - Bundled by `npm run bundle:functions` into `health/index.js`
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
}

const CORRELATION_RESPONSE_HEADER = 'x-correlation-id';

let cached: AppComposition | undefined;

function getApp(): AppComposition {
  if (!cached) cached = createComposition();
  return cached;
}

export async function healthHandler(
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

  // The health service never throws for a sick dependency (it reports
  // `degraded`), so a 500 here always means the API itself is broken.
  const result = await app.healthRoute.handle();

  context.res = {
    status: 200,
    headers: {
      ...middleware.securityHeaders(),
      'Content-Type': 'application/json',
      [CORRELATION_RESPONSE_HEADER]: correlationId,
    },
    body: result,
  };
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = healthHandler;
