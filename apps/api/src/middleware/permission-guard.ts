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
   * auth/04: registry enforcement. Resolves the session ONCE and requires
   * ALL listed permissions (empty array = no check — the route enforces
   * its own auth: public, token, webhook, API-key, or adapter-level).
   * Throws 401 when unauthenticated, 403 (audit-logged) when any
   * permission is missing.
   */
  requirePermissions(
    permissions: readonly Permission[],
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
  /**
   * #730: dangerous actions (view-as, mark-paid, user deactivation, API-key
   * issuance) need a recent sign-in. Throws 401 REAUTH_REQUIRED
   * (audit-logged) when `ctx.authenticatedAt` is older than the configured
   * window, missing, or the guard was built without a window (fail closed).
   */
  requireRecentAuth(ctx: AuthContext, route: string): Promise<void>;
}

export interface PermissionGuardDeps {
  readonly authContext: AuthContextService;
  /**
   * #730: SESSION_REAUTH_WINDOW_SECONDS. Optional so guards for routes
   * without dangerous actions need not carry it; when absent,
   * `requireRecentAuth` always refuses (fail closed).
   */
  readonly reauthWindowSeconds?: number;
  readonly clock?: () => Date;
}

function unauthenticated(): HttpError {
  return new HttpError(
    401,
    ErrorCodes.UNAUTHENTICATED,
    'Authentication required.',
    false,
  );
}

function reauthRequired(): HttpError {
  return new HttpError(
    401,
    ErrorCodes.REAUTH_REQUIRED,
    'Please sign in again to continue.',
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
  const { authContext, reauthWindowSeconds, clock = () => new Date() } = deps;

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

    async requirePermissions(permissions, headers, route) {
      const ctx = await authContext.resolve(headers);
      if (!ctx) throw unauthenticated();
      const missing = permissions.filter(
        (p) => !hasPermission(ctx.permissions, p),
      );
      if (missing.length > 0) {
        await authContext.auditDenied({
          ctx,
          permission: missing.join(','),
          route,
        });
        throw forbidden();
      }
      // auth/04: every successful protected action while view-as is active
      // is audit-logged under the REAL administrator.
      await authContext.auditViewAsAction({ ctx, route });
      return ctx;
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

    async requireRecentAuth(ctx, route) {
      const signedInAt = ctx.authenticatedAt?.getTime();
      const fresh =
        reauthWindowSeconds !== undefined &&
        signedInAt !== undefined &&
        clock().getTime() - signedInAt <= reauthWindowSeconds * 1000;
      if (fresh) return;
      await authContext.auditDenied({
        ctx,
        permission: 'recent-auth',
        route,
      });
      throw reauthRequired();
    },
  };
}
