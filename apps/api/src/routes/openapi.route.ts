/**
 * Thin OpenAPI spec route (api-mcp/03).
 *
 * Serves the generated OpenAPI 3.1 spec at GET /api/v1/openapi.json.
 * Public by design — no auth. The spec is generated at build time from
 * the zod schemas; the drift test ensures it never goes stale.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { buildOpenApiSpec } from '../openapi/spec';

export interface OpenApiRouteDeps {
  readonly siteUrl: string;
  readonly version: string;
}

export interface OpenApiRoute {
  /** GET /api/v1/openapi.json — returns the OpenAPI 3.1 spec. */
  handle(): Promise<unknown>;
}

export function createOpenApiRoute(deps: OpenApiRouteDeps): OpenApiRoute {
  return {
    handle: async (): Promise<unknown> => {
      return buildOpenApiSpec({
        siteUrl: deps.siteUrl,
        version: deps.version,
      });
    },
  };
}
