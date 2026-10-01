/**
 * Thin builder org user-management route (auth/05).
 *
 * All routes are org-scoped via the session's active builder id and
 * require the `builder:users:manage` permission (`builder_admin` only):
 *
 * - `GET /api/v1/builder/users` — list users holding a membership in the
 *   active org.
 * - `POST /api/v1/builder/users/invite` — invite a team member. Roles are
 *   forced to builder roles (`builder_admin` | `builder_member`); the
 *   builder id comes from the SESSION — a client-supplied builder id is
 *   ignored entirely (never read).
 * - `PATCH /api/v1/builder/users/{id}` — rename, change org role, or
 *   activate/disable. The target must hold a membership in the active
 *   org. Renaming is additionally staff-gated: staff accounts can only
 *   be renamed by Feasly staff, never by a builder admin. Deactivate/
 *   reactivate is additionally org-scoped: the target must belong solely
 *   to the caller's org and hold no staff role (otherwise 403 — global
 *   lifecycle is Feasly-staff-only). Disabling kills the user's builder
 *   sessions immediately (the service also revokes admin + builder
 *   sessions server-side).
 * - `DELETE /api/v1/builder/users/{id}` — remove the user from the org
 *   (membership revoked; the user row is disabled when it has no other
 *   memberships, killing all sessions immediately).
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */

// ---------------------------------------------------------------------------
// Contract shapes — imported from `@feasly/contracts`, the single source
// of truth shared with the frontend lane.
// ---------------------------------------------------------------------------
import type {
  BuilderOrgUser,
  BuilderOrgUserInviteBody,
  BuilderOrgUserInviteResponse,
  BuilderOrgUserListResponse,
  BuilderOrgUserUpdateBody,
} from '@feasly/contracts';
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import type {
  AuthContext,
  AuthContextService,
} from '../../services/auth-context.service';
import type { PermissionGuard } from '../../middleware/permission-guard';
import type { BuilderSessionStore } from '../../services/builder-auth.service';
import {
  type BuilderRole,
  type PublicUser,
  type UserService,
} from '../../services/user.service';

export interface BuilderUsersRouteDeps {
  readonly userService: UserService;
  readonly permissionGuard: PermissionGuard;
  readonly authContext: AuthContextService;
  readonly builderSessions: BuilderSessionStore;
  readonly clock?: () => Date;
}

export interface BuilderUsersRoute {
  /** GET /api/v1/builder/users */
  list(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BuilderOrgUserListResponse>;
  /** POST /api/v1/builder/users/invite */
  invite(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<BuilderOrgUserInviteResponse>;
  /** PATCH /api/v1/builder/users/{id} */
  update(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
    body: unknown,
  ): Promise<BuilderOrgUser>;
  /** DELETE /api/v1/builder/users/{id} */
  remove(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
  ): Promise<{ readonly removed: true }>;
}

const inviteBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(200),
  role: z.enum(['builder_admin', 'builder_member']).default('builder_member'),
});

const updateBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  role: z.enum(['builder_admin', 'builder_member']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const ROUTE_LIST = 'GET /api/v1/builder/users';
const ROUTE_INVITE = 'POST /api/v1/builder/users/invite';

function toBuilderOrgUser(user: PublicUser, builderId: string): BuilderOrgUser {
  const membership = user.memberships.find((m) => m.builderId === builderId);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    role: membership?.role ?? 'builder_member',
  };
}

function parseUserId(id: unknown): string {
  const parsed = z.string().trim().uuid().max(100).safeParse(id);
  if (!parsed.success) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      'A valid user id is required.',
      false,
    );
  }
  return parsed.data;
}

export function createBuilderUsersRoute(
  deps: BuilderUsersRouteDeps,
): BuilderUsersRoute {
  const {
    userService,
    permissionGuard,
    builderSessions,
    clock = () => new Date(),
  } = deps;

  /**
   * The caller's active org — from the SESSION, never a request param.
   * Requires the builder user-management permission.
   */
  async function requireOrgContext(
    headers: Record<string, string | string[] | undefined>,
    route: string,
  ): Promise<{ ctx: AuthContext; builderId: string }> {
    const ctx = await permissionGuard.requirePermission(
      'builder:users:manage',
      headers,
      route,
    );
    const builderId = await permissionGuard.requireBuilderId(ctx, route);
    return { ctx, builderId };
  }

  /** The target must hold a membership in the caller's active org. */
  function requireOrgMember(
    builderId: string,
    target: PublicUser,
  ): void {
    const inside = target.memberships.some((m) => m.builderId === builderId);
    if (!inside) {
      throw new HttpError(
        403,
        ErrorCodes.FORBIDDEN,
        'You can only manage users in your own organization.',
        false,
      );
    }
  }

  /**
   * Lifecycle scoping: a builder_admin may only deactivate/reactivate users
   * whose entire footprint is inside the caller's org — no staff role and
   * no memberships in other orgs. Anything broader is Feasly-staff
   * territory (the admin-users route keeps full global disable/enable).
   */
  function requireSoleOrgMember(
    builderId: string,
    target: PublicUser,
    action: 'deactivate' | 'reactivate',
  ): void {
    const outside =
      target.staffRole !== null ||
      target.memberships.some((m) => m.builderId !== builderId);
    if (outside) {
      throw new HttpError(
        403,
        ErrorCodes.FORBIDDEN,
        action === 'deactivate'
          ? 'You can only deactivate members who belong solely to your organization.'
          : 'You can only reactivate members who belong solely to your organization.',
        false,
      );
    }
  }

  return {
    async list(headers): Promise<BuilderOrgUserListResponse> {
      const { builderId } = await requireOrgContext(headers, ROUTE_LIST);
      const users = await userService.listUsers(100, 0, {
        builderIds: [builderId],
      });
      return {
        users: users.map((u) => toBuilderOrgUser(u, builderId)),
      };
    },

    async invite(
      headers,
      body,
    ): Promise<BuilderOrgUserInviteResponse> {
      const { ctx, builderId } = await requireOrgContext(headers, ROUTE_INVITE);
      const parsed = inviteBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'A valid email, name, and builder role are required.',
          false,
        );
      }
      // The builder id comes from the session — never the request body.
      const { user, emailSent } = await userService.invite({
        email: parsed.data.email,
        name: parsed.data.name,
        role: parsed.data.role as BuilderRole,
        builderId,
        invitedBy: ctx.userId,
        inviterName: ctx.name,
        actorEmail: ctx.email,
      });
      return {
        user: toBuilderOrgUser(user, builderId),
        emailSent,
      };
    },

    async update(headers, id, body): Promise<BuilderOrgUser> {
      const route = 'PATCH /api/v1/builder/users/{id}';
      const { ctx, builderId } = await requireOrgContext(headers, route);
      const userId = parseUserId(id);
      const parsed = updateBodySchema.safeParse(body ?? {});
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid update body.',
          false,
        );
      }
      const target = await userService.findById(userId);
      if (!target) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'User not found.', false);
      }
      requireOrgMember(builderId, target);
      if (target.id === ctx.userId) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'You can\u2019t change your own membership here.',
          false,
        );
      }

      let updated = target;
      // Role change = replace the org membership role.
      if (parsed.data.role) {
        const others = target.memberships
          .filter((m) => m.builderId !== builderId)
          .map((m) => ({ builderId: m.builderId, role: m.role }));
        updated = await userService.setMemberships(userId, [
          ...others,
          { builderId, role: parsed.data.role as BuilderRole },
        ]);
      }
      if (parsed.data.name && parsed.data.name !== updated.name) {
        // Hardening: a name is a platform-global field — a builder admin
        // may rename members of their own org, but staff accounts are
        // renamed by Feasly staff only (via the admin-users route with
        // `users:manage`), even when they hold a membership in this org.
        if (target.staffRole !== null) {
          throw new HttpError(
            403,
            ErrorCodes.FORBIDDEN,
            'Staff accounts can only be renamed by Feasly staff.',
            false,
          );
        }
        updated = await userService.renameUser(userId, parsed.data.name, {
          actorEmail: ctx.email,
        });
      }
      if (parsed.data.status === 'disabled' && updated.status !== 'disabled') {
        // Org-scoped lifecycle: the global disable below is only safe when
        // the target has no footprint outside the caller's org. The
        // per-org last-admin guard still runs inside disableUser.
        requireSoleOrgMember(builderId, updated, 'deactivate');
        updated = await userService.disableUser(userId, {
          actorEmail: ctx.email,
          actorId: ctx.userId ?? undefined,
        });
        // Immediate session kill: revoke the user's builder sessions
        // server-side (auth-context already fails closed on `disabled`).
        await builderSessions.revokeByUserId(userId, clock());
      } else if (
        parsed.data.status === 'active' &&
        updated.status === 'disabled'
      ) {
        // Same scoping on reactivate: never undo lifecycle actions on
        // users outside the caller's org or on staff accounts.
        requireSoleOrgMember(builderId, updated, 'reactivate');
        updated = await userService.enableUser(userId, {
          actorEmail: ctx.email,
        });
      }
      return toBuilderOrgUser(updated, builderId);
    },

    async remove(headers, id): Promise<{ readonly removed: true }> {
      const route = 'DELETE /api/v1/builder/users/{id}';
      const { ctx, builderId } = await requireOrgContext(headers, route);
      const userId = parseUserId(id);
      const target = await userService.findById(userId);
      if (!target) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'User not found.', false);
      }
      requireOrgMember(builderId, target);
      if (target.id === ctx.userId) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'You can\u2019t remove yourself from the organization.',
          false,
        );
      }
      if (target.isProtected) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This account can\u2019t be removed.',
          false,
        );
      }
      // Drop the org membership. When it's the user's last membership,
      // disable the row too — a user with no orgs must not keep sessions.
      const remaining = target.memberships.filter(
        (m) => m.builderId !== builderId,
      );
      await userService.setMemberships(
        userId,
        remaining.map((m) => ({ builderId: m.builderId, role: m.role })),
      );
      if (remaining.length === 0 && !target.staffRole) {
        await userService.disableUser(userId, {
          actorEmail: ctx.email,
          actorId: ctx.userId ?? undefined,
        });
      }
      // Immediate session kill either way.
      await builderSessions.revokeByUserId(userId, clock());
      return { removed: true as const };
    },
  };
}

// Re-export for the registry's permission check (auth/04).
export const BUILDER_USER_MANAGE_PERMISSION = 'builder:users:manage' as const;
