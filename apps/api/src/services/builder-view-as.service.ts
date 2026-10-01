/**
 * Builder-side view-as service (2026-09-30, Karan).
 *
 * Lets a `builder_admin` (the only builder role holding the `view_as`
 * permission) see the portal the way one of their org's regular team
 * members sees it — e.g. to check what a `builder_member` sees on the
 * leads pipeline.
 *
 * Reuses the admin-side session/token mechanism (auth/04): the session's
 * `view_as` field is set to `{ userId }`, and from then on the
 * AuthContextService resolves effective permissions + tenant scoping to
 * the TARGET's view. No parallel auth scheme.
 *
 * Guarantees (same as the admin side, plus org scoping):
 * - Initiator must hold `view_as` (defense in depth — the route enforces
 *   it too). `builder_member` can never initiate.
 * - Targets are userId-only and org-scoped: the target must hold a
 *   membership in the actor's own org (from the SESSION, never a request
 *   value). Cross-org targets are 403, never honored.
 * - #394 lockdown, unchanged: a staff `super_admin`/`admin`, or anyone
 *   holding a `builder_admin` membership (any org), can never be
 *   viewed-as (403 + `authz.denied` audit).
 * - Never escalates: the target's permissions are computed fresh from the
 *   target's roles — never unioned with the real admin's. View-as is
 *   terminal: the target view never carries `view_as` itself.
 * - Activation requires an ACTIVE BUILDER session: a token that doesn't
 *   resolve in the builder session store is a 401, never a lying
 *   `{active: true}`.
 * - Every activation, denial, and exit is audit-logged under the REAL
 *   builder admin's identity (never the target's).
 * - Targets must exist (and users must be active); a missing target is a
 *   404, never a silent widen.
 */
import { ErrorCodes, HttpError } from '../middleware/errors';
import { hasPermission } from '../auth/permissions';
import type { AdminAuditStore } from './admin-audit.store';
import { hashBuilderSessionToken, type BuilderSessionStore } from './builder-auth.service';
import type { AuthContext } from './auth-context.service';
import type {
  MembershipStore,
  UserStore,
} from './user.service';

export interface BuilderViewAsService {
  /**
   * Activate view-as on the caller's builder session. The caller must
   * already hold the `view_as` permission and the target must be a
   * regular user in the caller's own org.
   */
  activate(
    sessionToken: string | null,
    targetUserId: string,
    actor: AuthContext,
  ): Promise<{ readonly active: true }>;
  /** Exit view-as on the caller's builder session. Audit-logged. */
  exit(
    sessionToken: string | null,
    actor: AuthContext,
  ): Promise<{ readonly active: false }>;
}

export interface BuilderViewAsServiceDeps {
  readonly sessions: BuilderSessionStore;
  readonly users: UserStore;
  readonly memberships: MembershipStore;
  readonly audit: AdminAuditStore;
  /** Injectable clock for session-expiry checks. Defaults to wall time. */
  readonly clock?: () => Date;
}

function requireToken(sessionToken: string | null): string {
  if (!sessionToken) {
    throw new HttpError(
      401,
      ErrorCodes.UNAUTHENTICATED,
      'Authentication required.',
      false,
    );
  }
  return sessionToken;
}

function realEmail(actor: AuthContext): string | null {
  return actor.realUser?.email ?? actor.email;
}

export function createBuilderViewAsService(
  deps: BuilderViewAsServiceDeps,
): BuilderViewAsService {
  const { sessions, users, memberships, audit } = deps;
  const clock = deps.clock ?? (() => new Date());

  return {
    async activate(sessionToken, targetUserId, actor) {
      // Defense in depth: the route already enforces `view_as` via
      // requirePermission, but activation must never depend on a single
      // check — verify the actor's resolved permissions here too. While
      // viewing-as, the borrowed view strips `view_as` (#394 terminal),
      // so a viewed-as session can never chain into another view-as.
      if (!hasPermission(actor.permissions, 'view_as')) {
        await audit.log({
          actorEmail: realEmail(actor),
          action: 'authz.denied',
          detail: 'route=builder-view-as permission=view_as',
        });
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'You don\u2019t have access to this.',
          false,
        );
      }
      const token = requireToken(sessionToken);
      const hash = hashBuilderSessionToken(token);
      // Fail closed: view-as state lives in the BUILDER session store. A
      // token that isn't an active builder session (e.g. an admin-portal
      // token presented to this endpoint) must never get a lying
      // `{active: true}` — the updateState below would silently no-op.
      const session = await sessions.findActiveByHash(hash, clock());
      if (!session) {
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'Authentication required.',
          false,
        );
      }

      // Org scoping: the actor's org comes from the SESSION, never a
      // request value. A session with no org cannot initiate view-as.
      const orgId = actor.builderId;
      if (!orgId) {
        await audit.log({
          actorEmail: realEmail(actor),
          action: 'authz.denied',
          detail: 'route=builder-view-as reason=no-org-context',
        });
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'You don\u2019t have access to this.',
          false,
        );
      }

      const targetUser = await users.findById(targetUserId);
      if (!targetUser || targetUser.status === 'disabled') {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'User not found.', false);
      }

      const targetMemberships = await memberships.listByUserId(targetUser.id);

      // Lockdown (#394, Karan): nobody may view-as an admin — a staff
      // super_admin/admin, or anyone holding a builder_admin membership
      // (in ANY org). Admin powers must never be borrowable.
      const isAdminTarget =
        targetUser.staffRole === 'super_admin' ||
        targetUser.staffRole === 'admin' ||
        targetMemberships.some((m) => m.role === 'builder_admin');
      if (isAdminTarget) {
        await audit.log({
          actorEmail: realEmail(actor),
          action: 'authz.denied',
          detail: `route=builder-view-as target=user:${targetUser.id} reason=admin-target`,
        });
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'You can\u2019t view this account.',
          false,
        );
      }

      // Org scoping: the target must hold a membership in the actor's own
      // org. Anything else is 403 — a forged userId for another org is
      // never honored, never silently re-scoped.
      const insideOrg = targetMemberships.some((m) => m.builderId === orgId);
      if (!insideOrg) {
        await audit.log({
          actorEmail: realEmail(actor),
          action: 'authz.denied',
          detail: `route=builder-view-as target=user:${targetUser.id} reason=cross-org`,
        });
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'You can only view team members in your own organization.',
          false,
        );
      }

      await sessions.updateState(hash, {
        viewAs: { userId: targetUser.id },
      });
      await audit.log({
        actorEmail: realEmail(actor),
        action: 'view_as.activated',
        detail: `target=user:${targetUser.id}`,
      });
      return { active: true as const };
    },

    async exit(sessionToken, actor) {
      const token = requireToken(sessionToken);
      const hash = hashBuilderSessionToken(token);
      // Fail closed on exit too: only an active builder session can clear
      // view-as state, and exiting restores the session's own permissions
      // (auth-context resolves viewAs: null again on the next request).
      const session = await sessions.findActiveByHash(hash, clock());
      if (!session) {
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'Authentication required.',
          false,
        );
      }
      await sessions.updateState(hash, { viewAs: null });
      await audit.log({
        actorEmail: realEmail(actor),
        action: 'view_as.exited',
        detail: 'view-as',
      });
      return { active: false as const };
    },
  };
}
