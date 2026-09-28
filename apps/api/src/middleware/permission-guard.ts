/**
 * Permission guard (auth/04) — the enforcement half of the permission model.
 *
 * `requirePermission('leads:read')` resolves the request's session into an
 * AuthContext (via AuthContextService) and checks the effective
 * permissions:
 * - no valid session → 401 UNAUTHENTICATED,
 * - session valid but permission missing → 403 FORBIDDEN (`code:
 *   "FORBIDDEN"`), audit-logged, no data leak in the error.
 *
 * `requireBuilderId(ctx)` is the tenant-scoping helper every builder route
 * uses: the active builder comes from the SESSION, never from a request
 * param. Client-supplied builder ids are ignored — routes must not read
 * them at all; when a route genuinely needs one (admin flows), it resolves
 * the builder by id and the permission check decides.
 *
 * Layering (enforced by test/boundaries.test.ts): middleware NEVER imports
 * from src/db/ — it depends on the AuthContextService interface; only
 * composition.ts wires the implementation.
 */
import { ErrorCodes, HttpError } from './errors';
import {
  hasPermission,
  type Permission,
} from '../auth/permissions';
import type {
  AuthContext,
  AuthContextService,
} from '../services/auth-context.service';

export interface PermissionGuard {
  /**
   * Resolve + authorize. Returns the AuthContext for audit rows and tenant
   * scoping. Throws 401 when unauthenticated, 403 (audit-logged) when the
   * permission is missing.
   */
  requirePermission(
    permission: Permission | readonly Permission[],
    headers: Record<string, string | string[] | undefined>,
    route: string,
  ): Promise<AuthContext>;
  /**
   * Resolve without authorizing (for session-only routes like /auth/me).
   * Returns null when unauthenticated — the route maps it to 401.
   */
  getAuthContext(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthContext | null>;
  /**
   * Tenant-scoping helper: the builder id every builder route scopes its
   * SQL to. Throws 403 when the session carries no builder context.
   */
  requireBuilderId(ctx: AuthContext, route: string): Promise<string>;
}

export interface PermissionGuardDeps {
  readonly authContext: AuthContextService;
}

function unauthenticated(): HttpError {
  return new HttpError(
    401,
    ErrorCodes.UNAUTHENTICATED,
    'Authentication required.',
    false,
  );
}

function forbidden(): HttpError {
  return new HttpError(
    403,
    ErrorCodes.FORBIDDEN,
    'You don\u2019t have access to this.',
    false,
  );
}

export function createPermissionGuard(
  deps: PermissionGuardDeps,
): PermissionGuard {
  const { authContext } = deps;

  return {
    async requirePermission(permission, headers, route) {
      const ctx = await authContext.resolve(headers);
      if (!ctx) throw unauthenticated();
      const required = Array.isArray(permission) ? permission : [permission];
      const allowed = required.some((p) => hasPermission(ctx.permissions, p));
      if (!allowed) {
        await authContext.auditDenied({
          ctx,
          permission: required.join(','),
          route,
        });
        throw forbidden();
      }
      return ctx;
    },

    async getAuthContext(headers) {
      return authContext.resolve(headers);
    },

    async requireBuilderId(ctx, route) {
      if (!ctx.builderId) {
        await authContext.auditDenied({
          ctx,
          permission: 'builder-context',
          route,
        });
        throw forbidden();
      }
      return ctx.builderId;
    },
  };
}
