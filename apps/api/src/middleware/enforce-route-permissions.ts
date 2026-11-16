/**
 * Registry-driven route enforcement (auth/04).
 *
 * Every Functions adapter declares its registry path; the shared dispatch
 * calls `enforceRoutePermissions` before invoking the route. The route's
 * `permissions` declaration from the registry becomes REAL authorization:
 * - entry missing → 500 fail-closed (an adapter without a registry entry
 *   must not serve traffic),
 * - `permissions: []` with no `permissionsAnyOf` → no session check here
 *   (public, single-use-token, webhook-signature, API-key, or
 *   adapter-level-auth routes enforce their own auth),
 * - otherwise → `requirePermissions` (401 no session, 403 audit-logged
 *   when any permission is missing). When `permissionsAnyOf` is set, the
 *   caller additionally needs ANY ONE of those (OR) — for routes two
 *   roles may call under different permission strings.
 *
 * - `recentAuth: true` → additionally `requireRecentAuth` (#730): the
 *   session's sign-in must be inside SESSION_REAUTH_WINDOW_SECONDS, else
 *   401 REAUTH_REQUIRED.
 *
 * This is the DRY enforcement point: one helper, every adapter. Registry
 * declarations alone are not security — this call is what makes them so.
 */
import { ROUTE_REGISTRY } from '../registry/route-registry';
import { ErrorCodes, HttpError } from './errors';
import type { PermissionGuard } from './permission-guard';

export async function enforceRoutePermissions(
  permissionGuard: PermissionGuard,
  method: string | undefined,
  path: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<void> {
  const httpMethod = (method ?? 'GET').toUpperCase();
  const entry = ROUTE_REGISTRY.find(
    (candidate) =>
      candidate.method === httpMethod && candidate.path === path,
  );
  if (!entry) {
    throw new HttpError(
      500,
      ErrorCodes.INTERNAL_ERROR,
      'Route is not registered.',
      true,
    );
  }
  // auth/03: OR branch — the caller needs any one of permissionsAnyOf.
  // requirePermission with an array is OR (`.some`), matching the route
  // layer's own check; the route then applies role-specific scoping.
  const anyOf = entry.permissionsAnyOf ?? [];
  const hasAnyOf = anyOf.length > 0;
  if (hasAnyOf) {
    await permissionGuard.requirePermission(
      anyOf,
      headers,
      `${httpMethod} ${path}`,
    );
  }
  if (entry.permissions.length === 0 && !hasAnyOf) return;
  // `requirePermissions` also audit-logs the action under the REAL actor
  // when view-as is active (#731 AC5) — so it runs for anyOf-only routes
  // too (with an empty AND list it only resolves + audits).
  const ctx = await permissionGuard.requirePermissions(
    entry.permissions,
    headers,
    `${httpMethod} ${path}`,
  );
  // #730: dangerous actions need a recent sign-in (401 REAUTH_REQUIRED).
  if (entry.recentAuth) {
    await permissionGuard.requireRecentAuth(ctx, `${httpMethod} ${path}`);
  }
}
