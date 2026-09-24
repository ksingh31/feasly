/**
 * Thin PIPEDA privacy routes (legal/02). Routes are adapters, not logic:
 * extract the bearer token from headers → call exactly one service method →
 * return the result.
 *
 * - GET  /api/v1/privacy/export                  → exportMyData
 * - POST /api/v1/privacy/erase-requests          → requestErasure
 * - POST /api/v1/privacy/erase-requests/{id}/confirm → confirmErasure
 *
 * Authenticated by magic-link bearer token (the service owns verification).
 * Runs inside the BE0-003 request pipeline via the Azure Functions trigger
 * adapters (`src/functions/privacy.ts`).
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type {
  ErasureConfirmResponse,
  ErasureRequestResponse,
  PrivacyExportResponse,
} from '@feasly/contracts';
import type { PrivacyService } from '../services/privacy.service';

export interface PrivacyRequestHeaders {
  readonly authorization?: string | string[] | undefined;
}

export interface PrivacyRouteDeps {
  readonly privacy: PrivacyService;
}

export interface PrivacyRoute {
  exportData(headers: PrivacyRequestHeaders): Promise<PrivacyExportResponse>;
  requestErasure(headers: PrivacyRequestHeaders): Promise<ErasureRequestResponse>;
  confirmErasure(
    headers: PrivacyRequestHeaders,
    requestId: string,
  ): Promise<ErasureConfirmResponse>;
}

/**
 * Extract the bearer token from an Authorization header. Returns undefined
 * when absent or malformed — the service turns that into a uniform 401.
 * The scheme match is case-insensitive per RFC 7235; the token itself is
 * never logged or echoed.
 */
export function extractBearerToken(
  headers: PrivacyRequestHeaders,
): string | undefined {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const space = value.indexOf(' ');
  if (space < 0) return undefined;
  const scheme = value.slice(0, space);
  const token = value.slice(space + 1).trim();
  if (scheme.toLowerCase() !== 'bearer' || token.length === 0) return undefined;
  return token;
}

export function createPrivacyRoute(deps: PrivacyRouteDeps): PrivacyRoute {
  return {
    exportData: (headers) =>
      deps.privacy.exportMyData(extractBearerToken(headers)),
    requestErasure: (headers) =>
      deps.privacy.requestErasure(extractBearerToken(headers)),
    confirmErasure: (headers, requestId) =>
      deps.privacy.confirmErasure(extractBearerToken(headers), requestId),
  };
}
