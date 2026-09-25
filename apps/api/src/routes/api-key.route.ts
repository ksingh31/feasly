/**
 * Thin API-key admin route (api-mcp/01). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * All endpoints are admin-gated (the `AdminGuard` interface — currently the
 * interim pre-shared-key guard; admin/01 swaps in session auth).
 *
 * - `POST /api/v1/admin/api-keys` — issue a key (plaintext returned once).
 * - `POST /api/v1/admin/api-keys/{id}/rotate` — rotate (new plaintext once).
 * - `POST /api/v1/admin/api-keys/{id}/revoke` — revoke immediately.
 * - `GET /api/v1/admin/api-keys` — list active keys (masked prefixes only).
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  ApiKeyIssuedResponse,
  ApiKeyListResponse,
  ApiKeyRecordResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type {
  ApiKeyRecord,
  ApiKeyService,
} from '../services/api-key.service';

export interface ApiKeyRouteDeps {
  readonly apiKeys: ApiKeyService;
  readonly adminGuard: AdminGuard;
}

export interface ApiKeyRoute {
  /** POST /api/v1/admin/api-keys */
  issue(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<ApiKeyIssuedResponse>;
  /** POST /api/v1/admin/api-keys/{id}/rotate */
  rotate(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
  ): Promise<ApiKeyIssuedResponse>;
  /** POST /api/v1/admin/api-keys/{id}/revoke */
  revoke(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
  ): Promise<{ readonly revoked: true }>;
  /** GET /api/v1/admin/api-keys */
  list(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<ApiKeyListResponse>;
}

const keyIdParamSchema = z.string().trim().min(1).max(120);

function toResponse(record: ApiKeyRecord): ApiKeyRecordResponse {
  return {
    id: record.id,
    name: record.name,
    tenant_id: record.tenantId,
    key_prefix: record.keyPrefix,
    scopes: [...record.scopes] as ApiKeyRecordResponse['scopes'],
    rate_limit_per_min: record.rateLimitPerMin,
    sandbox: record.sandbox,
    revoked_at: record.revokedAt?.toISOString() ?? null,
    last_used_at: record.lastUsedAt?.toISOString() ?? null,
    created_at: record.createdAt.toISOString(),
  };
}

export function createApiKeyRoute(deps: ApiKeyRouteDeps): ApiKeyRoute {
  const { apiKeys, adminGuard } = deps;

  return {
    async issue(headers, body): Promise<ApiKeyIssuedResponse> {
      await adminGuard.requireAdmin(headers);
      const { key, plaintext } = await apiKeys.issue(body);
      return { key: toResponse(key), plaintext };
    },

    async rotate(headers, id): Promise<ApiKeyIssuedResponse> {
      await adminGuard.requireAdmin(headers);
      const parsed = keyIdParamSchema.safeParse(id);
      if (!parsed.success) {
        throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid key id.', false);
      }
      const { key, plaintext } = await apiKeys.rotate(parsed.data);
      return { key: toResponse(key), plaintext };
    },

    async revoke(headers, id): Promise<{ readonly revoked: true }> {
      await adminGuard.requireAdmin(headers);
      const parsed = keyIdParamSchema.safeParse(id);
      if (!parsed.success) {
        throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid key id.', false);
      }
      await apiKeys.revoke(parsed.data);
      return { revoked: true };
    },

    async list(headers): Promise<ApiKeyListResponse> {
      await adminGuard.requireAdmin(headers);
      const keys = await apiKeys.list();
      return { keys: keys.map(toResponse) };
    },
  };
}
