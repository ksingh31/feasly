/**
 * View-as service (auth/04).
 *
 * `super_admin` / `admin` holders (anyone with the `view_as` permission)
 * can activate a view-as session: the session's `view_as` field is set to
 * `{ builderId }` or `{ userId }`, and from then on the AuthContextService
 * resolves effective permissions + tenant scoping to the TARGET's view.
 *
 * Guarantees:
 * - Never escalates: the target's permissions are computed fresh from the
 *   target's roles — never unioned with the real admin's.
 * - Every activation, action, and exit is audit-logged under the REAL
 *   admin's identity (never the target's).
 * - Targets must exist (and users must be active); a missing target is a
 *   404, never a silent widen.
 */
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuditStore } from './admin-audit.store';
import {
  hashSessionToken,
  type AdminSessionStore,
} from './admin-auth.service';
import type {
  AuthContext,
  AuthContextService,
} from './auth-context.service';
import type { BuilderService } from './builder.service';
import type {
  MembershipStore,
  UserStore,
} from './user.service';

export type ViewAsTargetInput =
  | { readonly builderId: string }
  | { readonly userId: string };

export interface ViewAsService {
  /**
   * Activate view-as on the caller's session. The caller must already hold
   * the `view_as` permission (enforced by the route via requirePermission).
   */
  activate(
    sessionToken: string | null,
    target: ViewAsTargetInput,
    actor: AuthContext,
  ): Promise<{ readonly active: true }>;
  /** Exit view-as on the caller's session. Audit-logged. */
  exit(
    sessionToken: string | null,
    actor: AuthContext,
  ): Promise<{ readonly active: false }>;
  /**
   * Switch the session's active builder (org switcher). The builder must be
   * one of the caller's memberships — anything else is 403, never honored.
   */
  switchBuilder(
    sessionToken: string | null,
    builderId: string,
    actor: AuthContext,
  ): Promise<{ readonly builderId: string }>;
}

export interface ViewAsServiceDeps {
  readonly sessions: AdminSessionStore;
  readonly users: UserStore;
  readonly memberships: MembershipStore;
  readonly builders: Pick<BuilderService, 'getBuilder'>;
  readonly authContext: AuthContextService;
  readonly audit: AdminAuditStore;
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

export function createViewAsService(deps: ViewAsServiceDeps): ViewAsService {
  const { sessions, users, memberships, builders, audit } = deps;

  return {
    async activate(sessionToken, target, actor) {
      const token = requireToken(sessionToken);
      const hash = hashSessionToken(token);

      if ('builderId' in target) {
        // getBuilder throws 404 when unknown — a missing target is a 404,
        // never a silent widen.
        const builder = await builders.getBuilder(target.builderId);
        await sessions.updateState(
          hash,
          {
            viewAs: { builderId: builder.id },
          },
        );
        await audit.log({
          actorEmail: actor.realUser?.email ?? actor.email,
          action: 'view_as.activated',
          detail: `target=builder:${builder.id}`,
        });
        return { active: true as const };
      }

      const targetUser = await users.findById(target.userId);
      if (!targetUser || targetUser.status === 'disabled') {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'User not found.', false);
      }
      await sessions.updateState(hash, {
        viewAs: { userId: targetUser.id },
      });
      await audit.log({
        actorEmail: actor.realUser?.email ?? actor.email,
        action: 'view_as.activated',
        detail: `target=user:${targetUser.id}`,
      });
      return { active: true as const };
    },

    async exit(sessionToken, actor) {
      const token = requireToken(sessionToken);
      await sessions.updateState(hashSessionToken(token), { viewAs: null });
      await audit.log({
        actorEmail: actor.realUser?.email ?? actor.email,
        action: 'view_as.exited',
        detail: 'view-as',
      });
      return { active: false as const };
    },

    async switchBuilder(sessionToken, builderId, actor) {
      const token = requireToken(sessionToken);
      if (!actor.userId) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'You don\u2019t have access to this.',
          false,
        );
      }
      const userMemberships = await memberships.listByUserId(actor.userId);
      const membership = userMemberships.find((m) => m.builderId === builderId);
      if (!membership) {
        await audit.log({
          actorEmail: actor.realUser?.email ?? actor.email,
          action: 'authz.denied',
          detail: `route=switch-builder permission=builder-context`,
        });
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'You don\u2019t have access to this.',
          false,
        );
      }
      await sessions.updateState(hashSessionToken(token), {
        activeBuilderId: builderId,
      });
      await audit.log({
        actorEmail: actor.realUser?.email ?? actor.email,
        action: 'builder_context.switched',
        detail: `builder=${builderId}`,
      });
      return { builderId };
    },
  };
}
