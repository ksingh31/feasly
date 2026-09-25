/**
 * API key authentication middleware (api-mcp/01).
 *
 * For the public v1 API (`/api/v1/properties/*`, `/api/v1/estimate`,
 * `/api/v1/leads`): parses `Authorization: Bearer <key>`, validates via
 * the ApiKeyService (hash lookup + active check), and attaches the auth
 * context. Per-route scope checks use `requireScope`.
 *
 * Failures are uniform RFC 7807 401s with code INVALID_API_KEY — no
 * distinction between unknown/revoked/malformed (no oracle).
 */
import { ErrorCodes, HttpError } from './errors';
import type { ApiKeyRecord, ApiKeyService } from '../services/api-key.service';

export interface ApiKeyAuthContext {
  readonly keyId: string;
  readonly scopes: readonly string[];
  readonly sandbox: boolean;
  readonly tenantId: string | null;
}

function bearerToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const match = /^Bearer (.+)$/.exec(value.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Authenticate the request's API key. Returns the auth context on success;
 * throws 401 INVALID_API_KEY on any failure.
 */
export async function authenticateApiKey(
  headers: Record<string, string | string[] | undefined>,
  apiKeys: ApiKeyService,
): Promise<ApiKeyAuthContext> {
  const token = bearerToken(headers);
  if (!token) {
    throw new HttpError(
      401,
      ErrorCodes.INVALID_API_KEY,
      'Invalid API key.',
      false,
    );
  }
  const record: ApiKeyRecord = await apiKeys.authenticate(token);
  return {
    keyId: record.id,
    scopes: record.scopes,
    sandbox: record.sandbox,
    tenantId: record.tenantId,
  };
}

/**
 * Scope gate for API-key-authenticated routes. Throws 403 FORBIDDEN when
 * the key lacks the required scope.
 */
export function requireScope(
  auth: ApiKeyAuthContext,
  scope: string,
): void {
  if (!auth.scopes.includes(scope)) {
    throw new HttpError(
      403,
      ErrorCodes.FORBIDDEN,
      `API key lacks the required scope: ${scope}.`,
      false,
    );
  }
}
