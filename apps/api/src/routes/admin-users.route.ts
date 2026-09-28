/**
 * Thin admin user-management route (auth/03). Routes are adapters, not
 * logic: validate input → permission check → call exactly one service
 * method → return the result.
 *
 * Microsoft Entra External ID owns every credential — Feasly stores no
 * passwords. "Invite" = create the external user in Entra via Graph
 * (inside UserService) + the local user/invitation rows.
 *
 * - `GET /api/v1/admin/users` — paginated user list (memberships
 *   included). Requires `users:manage`.
 * - `POST /api/v1/admin/users/invite` — invite by email. Staff with
 *   `users:manage` may grant any role; builder admins
 *   (`builder:users:manage`) may only invite builder roles into the
 *   builder orgs they administer. Cross-builder invites → 403.
 * - `GET /api/v1/admin/users/{id}` — one user. Requires `users:manage`.
 * - `PATCH /api/v1/admin/users/{id}` — name, staff role, status,
 *   memberships. Staff: full power. Builder admins: only users inside
 *   their own orgs, and only name/status/their-org memberships.
 * - `DELETE /api/v1/admin/users/{id}` — hard delete, only for users who
 *   never accepted (everyone else is deactivated). Requires
 *   `users:manage`.
 * - `POST /api/v1/admin/users/{id}/resend-invite` — re-issue a pending
 *   invitation. Same permission shape as invite.
 *
 * All server-side guards (protected rows, self-harm, last super_admin,
 * super_admin-grant rule, session revocation on deactivate) live in
 * UserService — this layer only scopes WHO may touch WHOM.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  AdminUser,
  AdminUserDeleteResponse,
  AdminUserInviteBody,
  AdminUserInviteResponse,
  AdminUserListResponse,
  AdminUserResendInviteResponse,
  AdminUserUpdateBody,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { PermissionGuard } from '../middleware/permission-guard';
import type { AuthContext } from '../services/auth-context.service';
import type { BuilderService } from '../services/builder.service';
import type {
  BuilderRole,
  PublicUser,
  StaffRole,
  UserService,
} from '../services/user.service';

export interface AdminUsersRouteDeps {
  readonly userService: UserService;
  readonly permissionGuard: PermissionGuard;
  readonly builders: Pick<BuilderService, 'getBuilder'>;
}

export interface AdminUsersRoute {
  /** GET /api/v1/admin/users */
  list(
    headers: Record<string, string | string[] | undefined>,
    query: unknown,
  ): Promise<AdminUserListResponse>;
  /** GET /api/v1/admin/users/{id} */
  get(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
  ): Promise<AdminUser>;
  /** POST /api/v1/admin/users/invite */
  invite(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<AdminUserInviteResponse>;
  /** PATCH /api/v1/admin/users/{id} */
  update(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
    body: unknown,
  ): Promise<AdminUser>;
  /** DELETE /api/v1/admin/users/{id} */
  remove(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
  ): Promise<{ deleted: true }>;
  /** POST /api/v1/admin/users/{id}/resend-invite */
  resendInvite(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
  ): Promise<AdminUserResendInviteResponse>;
}

const STAFF_ROLE_VALUES = ['super_admin', 'admin', 'viewer'] as const;
const BUILDER_ROLE_VALUES = ['builder_admin', 'builder_member'] as const;

const userIdParamSchema = z.string().trim().uuid();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const inviteBodySchema: z.ZodType<AdminUserInviteBody> = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().min(1).max(200),
  role: z.enum([...STAFF_ROLE_VALUES, ...BUILDER_ROLE_VALUES]),
  builderId: z.string().trim().uuid().optional(),
});

const membershipSchema = z.object({
  builderId: z.string().trim().uuid(),
  role: z.enum(BUILDER_ROLE_VALUES),
});

const updateBodySchema: z.ZodType<AdminUserUpdateBody> = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  staffRole: z.enum(STAFF_ROLE_VALUES).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  memberships: z.array(membershipSchema).optional(),
});

function parseUserId(id: unknown): string {
  const parsed = userIdParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      'Invalid user id.',
      false,
    );
  }
  return parsed.data;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      `Invalid ${what} body.`,
      false,
    );
  }
  return parsed.data;
}

function toAdminUser(user: PublicUser): AdminUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    staffRole: user.staffRole,
    isProtected: user.isProtected,
    memberships: user.memberships.map((m) => ({
      builderId: m.builderId,
      role: m.role,
    })),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/** Actor identity for the service guards + audit rows. */
function actorOpts(ctx: AuthContext): {
  readonly actorId: string | null;
  readonly actorEmail: string | null;
  readonly actorStaffRole: StaffRole | null;
} {
  // auth/04: under view-as the actor is the REAL administrator, never the
  // view-as target — the audit trail must name who actually acted.
  // actorStaffRole stays the target's view (view-as never escalates).
  return {
    actorId: ctx.realUser?.userId ?? ctx.userId,
    actorEmail: ctx.realUser?.email ?? ctx.email,
    actorStaffRole: ctx.staffRole,
  };
}

/**
 * Builder-admin orgs: the builder ids where the caller's membership role
 * is builder_admin. A builder admin can only invite/manage users inside
 * these — never another builder's org (auth/03 AC5).
 */
function adminOrgIds(ctx: AuthContext): string[] {
  return ctx.memberships
    .filter((m) => m.role === 'builder_admin')
    .map((m) => m.builderId);
}

/** Fail closed on unknown builders — never invite into a void org and
 * never leak builder existence to non-members (404 → 403). */
async function requireKnownBuilder(
  builders: Pick<BuilderService, 'getBuilder'>,
  builderId: string,
): Promise<void> {
  try {
    await builders.getBuilder(builderId);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new HttpError(
        403,
        ErrorCodes.FORBIDDEN,
        'Unknown organization.',
        false,
      );
    }
    throw err;
  }
}

export function createAdminUsersRoute(
  deps: AdminUsersRouteDeps,
): AdminUsersRoute {
  const { userService, permissionGuard, builders } = deps;

  /** Staff managers pass through; builder admins are scoped to their orgs. */
  async function inviteContext(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ctx: AuthContext; staffManager: boolean }> {
    const ctx = await permissionGuard.requirePermission(
      ['users:manage', 'builder:users:manage'] as const,
      headers,
      'POST /api/v1/admin/users/invite',
    );
    return {
      ctx,
      staffManager: ctx.permissions.includes('users:manage'),
    };
  }

  /** The target user must live in one of the caller's admin orgs. */
  function requireOrgMember(ctx: AuthContext, target: PublicUser): void {
    const orgs = adminOrgIds(ctx);
    const inside = target.memberships.some((m) => orgs.includes(m.builderId));
    if (!inside) {
      throw new HttpError(
        403,
        ErrorCodes.FORBIDDEN,
        'You can only manage users in your own organization.',
        false,
      );
    }
  }

  return {
    async list(headers, query): Promise<AdminUserListResponse> {
      const ctx = await permissionGuard.requirePermission(
        ['users:manage', 'builder:users:manage'] as const,
        headers,
        'GET /api/v1/admin/users',
      );
      const parsed = listQuerySchema.safeParse(query ?? {});
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid pagination query.',
          false,
        );
      }
      const { limit, offset } = parsed.data;
      // auth/03: builder admins only see users in the orgs they administer.
      const filter = ctx.permissions.includes('users:manage')
        ? undefined
        : { builderIds: adminOrgIds(ctx) };
      const [users, total] = await Promise.all([
        userService.listUsers(limit, offset, filter),
        userService.countUsers(filter),
      ]);
      return {
        users: users.map(toAdminUser),
        total,
        limit,
        offset,
      };
    },

    async get(headers, id): Promise<AdminUser> {
      const ctx = await permissionGuard.requirePermission(
        ['users:manage', 'builder:users:manage'] as const,
        headers,
        'GET /api/v1/admin/users/{id}',
      );
      const user = await userService.findById(parseUserId(id));
      if (!user) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'User not found.', false);
      }
      if (!ctx.permissions.includes('users:manage')) {
        requireOrgMember(ctx, user);
      }
      return toAdminUser(user);
    },

    async invite(headers, body): Promise<AdminUserInviteResponse> {
      const { ctx, staffManager } = await inviteContext(headers);
      const parsed = parseBody(inviteBodySchema, body, 'invite');
      const isBuilderRole = (
        BUILDER_ROLE_VALUES as readonly string[]
      ).includes(parsed.role);

      if (!staffManager) {
        // Builder admin: builder roles only, and only into orgs they
        // administer. A forged builderId for another org → 403, never
        // silently re-scoped (auth/04 defense in depth).
        if (!isBuilderRole || !parsed.builderId) {
          throw new HttpError(
            403,
            ErrorCodes.FORBIDDEN,
            'Builders can only invite team members into their own organization.',
            false,
          );
        }
        if (!adminOrgIds(ctx).includes(parsed.builderId)) {
          throw new HttpError(
            403,
            ErrorCodes.FORBIDDEN,
            'You can only invite users into your own organization.',
            false,
          );
        }
      }

      if (parsed.builderId) {
        await requireKnownBuilder(builders, parsed.builderId);
      }

      const { user, emailSent } = await userService.invite({
        email: parsed.email,
        name: parsed.name,
        role: parsed.role as StaffRole | BuilderRole,
        builderId: parsed.builderId ?? null,
        invitedBy: ctx.realUser?.userId ?? ctx.userId,
        inviterName: ctx.realUser?.name ?? ctx.name,
        actorEmail: ctx.realUser?.email ?? ctx.email,
        actorStaffRole: ctx.staffRole,
      });
      return { user: toAdminUser(user), emailSent };
    },

    async update(headers, id, body): Promise<AdminUser> {
      const userId = parseUserId(id);
      const ctx = await permissionGuard.requirePermission(
        ['users:manage', 'builder:users:manage'] as const,
        headers,
        'PATCH /api/v1/admin/users/{id}',
      );
      const staffManager = ctx.permissions.includes('users:manage');
      const parsed = parseBody(updateBodySchema, body, 'update');
      const actor = actorOpts(ctx);

      const target = await userService.findById(userId);
      if (!target) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'User not found.', false);
      }

      if (!staffManager) {
        // Builder admin: the target must already be in one of their orgs,
        // and they may not touch staff roles or other orgs' memberships.
        requireOrgMember(ctx, target);
        if (parsed.staffRole !== undefined) {
          throw new HttpError(
            403,
            ErrorCodes.FORBIDDEN,
            'Builders cannot change staff roles.',
            false,
          );
        }
      } else if (parsed.memberships !== undefined) {
        for (const m of parsed.memberships) {
          await requireKnownBuilder(builders, m.builderId);
        }
      }

      let result = target;
      if (parsed.name !== undefined && parsed.name !== target.name) {
        result = await userService.renameUser(userId, parsed.name, actor);
      }
      if (
        staffManager &&
        parsed.staffRole !== undefined &&
        parsed.staffRole !== result.staffRole
      ) {
        result = await userService.changeStaffRole(userId, parsed.staffRole, {
          ...actor,
          actorStaffRole: ctx.staffRole,
        });
      }
      if (parsed.status !== undefined && parsed.status !== result.status) {
        result =
          parsed.status === 'disabled'
            ? await userService.disableUser(userId, actor)
            : await userService.enableUser(userId, actor);
      }
      if (parsed.memberships !== undefined) {
        let desired = parsed.memberships;
        if (!staffManager) {
          // A builder admin's desired set replaces only their own orgs'
          // entries — memberships in other orgs are preserved untouched.
          const orgs = adminOrgIds(ctx);
          for (const m of parsed.memberships) {
            if (!orgs.includes(m.builderId)) {
              throw new HttpError(
                403,
                ErrorCodes.FORBIDDEN,
                'You can only manage memberships in your own organization.',
                false,
              );
            }
            await requireKnownBuilder(builders, m.builderId);
          }
          const others = target.memberships.filter(
            (m) => !orgs.includes(m.builderId),
          );
          desired = [
            ...others.map((m) => ({ builderId: m.builderId, role: m.role })),
            ...parsed.memberships,
          ];
        }
        result = await userService.setMemberships(userId, desired, actor);
      }
      return toAdminUser(result);
    },

    async remove(headers, id): Promise<AdminUserDeleteResponse> {
      const ctx = await permissionGuard.requirePermission(
        'users:manage',
        headers,
        'DELETE /api/v1/admin/users/{id}',
      );
      await userService.deleteUser(parseUserId(id), actorOpts(ctx));
      return { deleted: true };
    },

    async resendInvite(headers, id): Promise<AdminUserResendInviteResponse> {
      const { ctx, staffManager } = await inviteContext(headers);
      const userId = parseUserId(id);
      const target = await userService.findById(userId);
      if (!target) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'User not found.', false);
      }
      if (!staffManager) {
        requireOrgMember(ctx, target);
      }
      const { user, emailSent } = await userService.resendInvite(target.email, {
        invitedBy: ctx.realUser?.userId ?? ctx.userId,
        inviterName: ctx.realUser?.name ?? ctx.name,
        actorEmail: ctx.realUser?.email ?? ctx.email,
      });
      return { user: toAdminUser(user), emailSent };
    },
  };
}
