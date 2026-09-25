/**
 * Thin property route (api-mcp/02).
 * Routes are adapters, not logic: validate input → call exactly one service
 * method → return the result.
 *
 * - GET /api/v1/properties/autocomplete?q=… — public, cache-first.
 *   Short queries (< 3 chars) resolve to an empty suggestion list.
 * - GET /api/v1/properties/lookup?addressKey=… — public, cache-first.
 *   404 NOT_FOUND when the City has no record for the address.
 * - 503 DEPENDENCY_UNAVAILABLE (retryable) when the City API is down.
 *
 * The serialized responses are the `@feasly/contracts` PropertyRecord /
 * AutocompleteResponse shapes — the same contracts the web UI uses, so the
 * MCP server and white-label embeds speak the same property language.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type {
  AutocompleteResponse,
  PropertyRecord,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { PropertyService } from '../services/property.service';

export interface PropertyRouteDeps {
  readonly property: PropertyService;
}

export interface PropertyRoute {
  /** Autocomplete suggestions for a partial address query. */
  autocomplete(query: unknown): Promise<AutocompleteResponse>;
  /** Full property record for an exact address key. */
  lookup(addressKey: unknown): Promise<PropertyRecord>;
}

/** Addresses are printable, bounded-length strings — never empty. */
const MAX_QUERY_CHARS = 200;

function requireQueryString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      `Missing required query parameter: ${name}.`,
      false,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_QUERY_CHARS) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      `Query parameter ${name} is too long (max ${MAX_QUERY_CHARS} characters).`,
      false,
    );
  }
  return trimmed;
}

export function createPropertyRoute(deps: PropertyRouteDeps): PropertyRoute {
  return {
    autocomplete: async (query: unknown): Promise<AutocompleteResponse> =>
      deps.property.autocomplete(requireQueryString(query, 'q')),

    lookup: async (addressKey: unknown): Promise<PropertyRecord> =>
      deps.property.getProperty(requireQueryString(addressKey, 'addressKey')),
  };
}
