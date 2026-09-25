/**
 * Admin guard (INTERIM — api-mcp/01).
 *
 * api-mcp/01 depends on admin/01 (admin session auth), which is not built
 * yet. Until it lands, admin endpoints are gated by a pre-shared key in
 * the `X-Admin-Key` header, compared (timing-safe) against
 * `config.admin.apiKey`. Fail-closed: missing/unset key → every admin
 * call 401s.
 *
 * This is intentionally minimal and clearly marked: admin/01 replaces
 * `createConfigAdminGuard` with the session-based guard without touching
 * the routes (they depend on the `AdminGuard` interface, not this impl).
 */
import { timingSafeEqual } from 'node:crypto';
import { ErrorCodes, HttpError } from './errors';

export interface AdminGuard {
  /** Throws 401 UNAUTHENTICATED when the request is not from an admin. */
  requireAdmin(headers: Record<string, string | string[] | undefined>): void;
}

export interface ConfigAdminGuardDeps {
  /** The pre-shared admin key; undefined = fail closed. */
  readonly adminApiKey: string | undefined;
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() ? value.trim() : null;
}

export function createConfigAdminGuard(
  deps: ConfigAdminGuardDeps,
): AdminGuard {
  return {
    requireAdmin(headers) {
      const configured = deps.adminApiKey;
      const presented = header(headers, 'x-admin-key');
      const ok =
        !!configured &&
        !!presented &&
        configured.length === presented.length &&
        timingSafeEqual(Buffer.from(configured), Buffer.from(presented));
      if (!ok) {
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'Admin authentication required.',
          false,
        );
      }
    },
  };
}
