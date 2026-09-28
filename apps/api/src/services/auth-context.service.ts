/**
 * AuthContextService (auth/04) — resolves a request's session into the
 * authorization context every route enforces against.
 *
 * Resolution order: admin session (Entra) first, then builder session
 * (builder magic-link). The result carries:
 * - the user's identity + staff role + memberships,
 * - effective permissions (staff ∪ memberships, via `ROLE_PERMISSIONS`),
 * - the active builder tenant — ALWAYS from the session
 *   (`admin_sessions.active_builder_id`, set at sign-in / org switcher),
 *   never from a request param,
 * - view-as state: while `session.view_as` is set, permissions + scoping
 *   become the target's. Never escalates: the result is the target's view
 *   only, and `realUser` preserves the acting admin for the audit trail.
 *
 * Iron rule: tenant scoping happens here, server-side. Client-supplied
 * builder ids are never read, never honored.
 */
import {
  effectivePermissions,
  ROLE_PERMISSIONS,
  type Permission,
} from '../auth/permissions';
import { extractSessionToken } from '../middleware/session-token';
import { ADMIN_SESSION_COOKIE } from '../middleware/admin-guard';
import { BUILDER_SESSION_COOKIE } from '../middleware/builder-guard';
import type { AdminAuditStore } from './admin-audit.store';
import type {
  AdminSessionStore,
  ViewAsState,
} from './admin-auth.service';
import { hashSessionToken } from './admin-auth.service';
import type { BuilderAuthService } from './builder-auth.service';
import type { BuilderService } from './builder.service';
import type {
  BuilderMembership,
  BuilderRole,
  MembershipStore,
  StaffRole,
  UserRecord,
  UserStore,
} from './user.service';

export interface AuthContext {
  /** The user the session belongs to (null for legacy magic-link sessions). */
  readonly userId: string | null;
  readonly email: string;
  readonly name: string;
  readonly staffRole: StaffRole | null;
  readonly permissions: readonly Permission[];
  /**
   * Active builder tenant, resolved from the SESSION (active membership
   * choice). Null when the user has no builder context. Routes scope every
   * tenant query to this — a client-supplied builder id is ignored/403,
   * never honored.
   */
  readonly builderId: string | null;
  readonly builderName: string | null;
  /** All of the user's builder memberships (drives the org switcher UI). */
  readonly memberships: readonly BuilderMembership[];
  /** Set while view-as is active. */
  readonly viewAs: ViewAsState | null;
  /** The real admin behind a view-as session (null otherwise). */
  readonly realUser: {
    readonly userId: string | null;
    readonly email: string;
    readonly name: string;
  } | null;
}

export interface AuthContextService {
  /**
   * Resolve the session from headers into an AuthContext, or null when
   * there is no valid session (caller maps to 401 UNAUTHENTICATED).
   * Disabled users resolve to null — deactivation revokes access
   * immediately, including live sessions.
   */
  resolve(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthContext | null>;
  /**
   * Audit-log a denied authorization check (403). Detail carries ids and
   * the missing permission only — never request data.
   */
  auditDenied(args: {
    readonly ctx: AuthContext | null;
    readonly permission: string;
    readonly route: string;
  }): Promise<void>;
  /**
   * Audit-log a successful protected action taken while view-as is
   * active. The actor is always the REAL administrator (`ctx.realUser`),
   * never the view-as target. No-op when view-as is not active — normal
   * actions are not audit-logged at this layer.
   */
  auditViewAsAction(args: {
    readonly ctx: AuthContext;
    readonly route: string;
  }): Promise<void>;
}

export interface AuthContextServiceDeps {
  readonly adminSessions: AdminSessionStore;
  readonly builderAuth: BuilderAuthService;
  readonly users: UserStore;
  readonly memberships: MembershipStore;
  readonly builders: Pick<BuilderService, 'getBuilder' | 'getByTenantKey'>;
  readonly audit: AdminAuditStore;
  readonly clock?: () => Date;
}

/** Legacy magic-link sessions (no user row): conservative admin mapping. */
const LEGACY_SESSION_PERMISSIONS: readonly Permission[] =
  ROLE_PERMISSIONS.admin;

export function createAuthContextService(
  deps: AuthContextServiceDeps,
): AuthContextService {
  const {
    adminSessions,
    builderAuth,
    users,
    memberships,
    builders,
    audit,
    clock = () => new Date(),
  } = deps;

  async function resolveAdminSession(
    token: string,
  ): Promise<AuthContext | null> {
    const session = await adminSessions.findActiveByHash(
      hashSessionToken(token),
      clock(),
    );
    if (!session) return null;

    // Legacy (pre-user-model) magic-link sessions have no user row: they
    // were issued to allowlisted admins — map to admin, never super_admin.
    if (!session.userId) {
      return {
        userId: null,
        email: session.email,
        name: session.email,
        staffRole: 'admin',
        permissions: LEGACY_SESSION_PERMISSIONS,
        builderId: null,
        builderName: null,
        memberships: [],
        viewAs: null,
        realUser: null,
      };
    }

    const user = await users.findById(session.userId);
    if (!user || user.status === 'disabled') return null;

    const userMemberships = await memberships.listByUserId(user.id);
    let builderId: string | null = null;
    let builderName: string | null = null;
    if (session.activeBuilderId) {
      const membership = userMemberships.find(
        (m) => m.builderId === session.activeBuilderId,
      );
      if (membership) {
        builderId = membership.builderId;
        try {
          builderName = (await builders.getBuilder(builderId)).displayName;
        } catch {
          builderName = null;
        }
      }
      // A dangling activeBuilderId (membership removed) yields no builder
      // context rather than a wrong one.
    }

    const realUser = {
      userId: user.id,
      email: user.email,
      name: user.name,
    };

    // View-as: the target's view only. Computed fresh from the target's
    // roles — never unioned with the real user's permissions (no
    // escalation). An unknown/disabled target fails CLOSED: empty
    // permissions and no builder context, never the real user's own
    // context (which would silently restore elevated access). The real
    // identity stays on `realUser` for the audit trail, and `viewAs`
    // stays set so the shell can show "target unavailable" + an exit.
    const closedViewAs = {
      userId: user.id,
      email: user.email,
      name: user.name,
      staffRole: null,
      permissions: [] as readonly Permission[],
      builderId: null,
      builderName: null,
      memberships: [] as readonly BuilderMembership[],
      viewAs: session.viewAs,
      realUser,
    };
    if (session.viewAs?.builderId) {
      try {
        const target = await builders.getBuilder(session.viewAs.builderId);
        return {
          userId: user.id,
          email: user.email,
          name: user.name,
          staffRole: null,
          permissions: ROLE_PERMISSIONS.builder_admin,
          builderId: target.id,
          builderName: target.displayName,
          memberships: [] as readonly BuilderMembership[],
          viewAs: session.viewAs,
          realUser,
        };
      } catch {
        return closedViewAs;
      }
    }
    if (session.viewAs?.userId) {
      const target = await users.findById(session.viewAs.userId);
      if (target && target.status !== 'disabled') {
        const targetMemberships = await memberships.listByUserId(target.id);
        const targetBuilder = targetMemberships[0] ?? null;
        let targetBuilderName: string | null = null;
        if (targetBuilder) {
          try {
            targetBuilderName = (
              await builders.getBuilder(targetBuilder.builderId)
            ).displayName;
          } catch {
            targetBuilderName = null;
          }
        }
        return {
          userId: target.id,
          email: target.email,
          name: target.name,
          staffRole: target.staffRole,
          permissions: effectivePermissions(
            target.staffRole,
            targetMemberships.map((m) => m.role),
          ),
          builderId: targetBuilder?.builderId ?? null,
          builderName: targetBuilderName,
          memberships: targetMemberships,
          viewAs: session.viewAs,
          realUser,
        };
      }
      // Unknown/disabled target — fail closed (see above).
      return closedViewAs;
    }

    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      staffRole: user.staffRole,
      permissions: effectivePermissions(
        user.staffRole,
        userMemberships.map((m) => m.role),
      ),
      builderId,
      builderName,
      memberships: userMemberships,
      viewAs: session.viewAs,
      realUser: session.viewAs ? realUser : null,
    };
  }

  async function resolveBuilderSession(
    token: string,
  ): Promise<AuthContext | null> {
    const session = await builderAuth.validateSession(token);
    if (!session) return null;
    // auth/04: the tenant comes from the session's server-side builder_id,
    // resolved at sign-in. Legacy sessions (builder_id NULL) fall back to
    // the tenant_key lookup; either way nothing is read from the request.
    const builder = session.builderId
      ? await builders.getBuilder(session.builderId).catch(() => null)
      : await builders.getByTenantKey(session.tenantKey);
    if (!builder || builder.status !== 'active') return null;

    // Prefer the user model's membership role when the builder has one;
    // otherwise the legacy parity mapping (the portal predates per-user
    // roles — a tenant session could do everything the portal offers).
    let permissions: readonly Permission[] = ROLE_PERMISSIONS.builder_admin;
    let userMemberships: BuilderMembership[] = [];
    let name = session.email;
    let userId: string | null = null;
    const user: UserRecord | null = await users.findByEmail(session.email);
    if (user) {
      if (user.status === 'disabled') return null;
      userId = user.id;
      name = user.name;
      userMemberships = await memberships.listByUserId(user.id);
      const membership = userMemberships.find(
        (m) => m.builderId === builder.id,
      );
      const role: BuilderRole = membership?.role ?? 'builder_admin';
      permissions = ROLE_PERMISSIONS[role];
    }

    return {
      userId,
      email: session.email,
      name,
      staffRole: null,
      permissions,
      builderId: builder.id,
      builderName: builder.displayName,
      memberships: userMemberships,
      viewAs: null,
      realUser: null,
    };
  }

  return {
    async resolve(headers) {
      const adminToken = extractSessionToken(headers, ADMIN_SESSION_COOKIE);
      if (adminToken) {
        const ctx = await resolveAdminSession(adminToken);
        if (ctx) return ctx;
        // A present-but-invalid admin token is not a builder token — deny.
        return null;
      }
      const builderToken = extractSessionToken(headers, BUILDER_SESSION_COOKIE);
      if (builderToken) {
        return resolveBuilderSession(builderToken);
      }
      return null;
    },

    async auditDenied({ ctx, permission, route }): Promise<void> {
      await audit.log({
        actorEmail: ctx?.realUser?.email ?? ctx?.email ?? null,
        action: 'authz.denied',
        detail: `route=${route} permission=${permission} view_as=${ctx?.viewAs ? '1' : '0'}`,
      });
    },

    async auditViewAsAction({ ctx, route }): Promise<void> {
      if (!ctx.viewAs) return;
      await audit.log({
        actorEmail: ctx.realUser?.email ?? ctx.email,
        action: 'authz.view_as_action',
        detail: `route=${route} view_as=1`,
      });
    },
  };
}
