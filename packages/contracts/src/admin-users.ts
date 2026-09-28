/**
 * Admin user-management contracts (auth/03).
 *
 * Microsoft Entra External ID owns every credential — Feasly stores no
 * passwords. "Invite" means: create the external user in Entra via
 * Microsoft Graph + create the user/invitation rows locally. The invitee
 * signs in with their Entra credentials at `/admin/login`.
 *
 * Backend routes:
 * - `GET /api/v1/admin/users` — paginated user list (incl. builder
 *   memberships). Requires `users:manage`.
 * - `POST /api/v1/admin/users/invite` — invite by email. Staff with
 *   `users:manage` may grant any role; builder admins (`builder:users:manage`)
 *   may only invite builder roles into their own builder org(s).
 * - `GET /api/v1/admin/users/{id}` — one user. Requires `users:manage`.
 * - `PATCH /api/v1/admin/users/{id}` — name, staff role, status
 *   (`active` | `disabled`), memberships. Requires `users:manage`.
 * - `DELETE /api/v1/admin/users/{id}` — hard delete, only for users who
 *   never accepted (status `invited`); everyone else is deactivated via
 *   PATCH. Requires `users:manage`.
 * - `POST /api/v1/admin/users/{id}/resend-invite` — re-issue a pending
 *   invitation (retries Graph when the first create failed).
 *
 * Server-side guards (all of them, fail closed): protected rows
 * (Karan's seed account) refuse edits; a user can't deactivate, delete,
 * or demote themselves; the last active super_admin can't be removed;
 * only a super_admin can grant the super_admin role; deactivation revokes
 * sessions immediately. Every mutation is audit-logged.
 */

/** Staff roles (Feasly side). Matches `users.staff_role`. */
export type AdminUserStaffRole = 'super_admin' | 'admin' | 'viewer';

/** Builder-org roles. Matches `builder_memberships.role`. */
export type AdminUserBuilderRole = 'builder_admin' | 'builder_member';

/** User lifecycle status. Matches `users.status`. */
export type AdminUserStatus = 'invited' | 'active' | 'disabled';

/** One builder membership on a user row. */
export interface AdminUserMembership {
  readonly builderId: string;
  readonly role: AdminUserBuilderRole;
}

/**
 * The user shape the admin UI works with. Never carries Entra object ids
 * or any credential material.
 */
export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly status: AdminUserStatus;
  readonly staffRole: AdminUserStaffRole | null;
  /** True for Karan's seed account — the API refuses edits on it. */
  readonly isProtected: boolean;
  readonly memberships: readonly AdminUserMembership[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `GET /api/v1/admin/users` response (offset pagination). */
export interface AdminUserListResponse {
  readonly users: readonly AdminUser[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** `POST /api/v1/admin/users/invite` body. */
export interface AdminUserInviteBody {
  readonly email: string;
  readonly name: string;
  /**
   * The role to grant. Staff roles need `builderId` absent; builder roles
   * need `builderId` present. Only roles the inviter may grant — the API
   * 403s anything wider (incl. a non-super_admin granting super_admin).
   */
  readonly role: AdminUserStaffRole | AdminUserBuilderRole;
  /** Builder the invitee joins (required for builder roles). */
  readonly builderId?: string;
}

/** `POST /api/v1/admin/users/invite` response. */
export interface AdminUserInviteResponse {
  readonly user: AdminUser;
  /** False when the invite email couldn't be sent (user row still created). */
  readonly emailSent: boolean;
}

/** `PATCH /api/v1/admin/users/{id}` body. All fields optional. */
export interface AdminUserUpdateBody {
  readonly name?: string;
  /** Pass null to strip the staff role (pure builder-side user). */
  readonly staffRole?: AdminUserStaffRole | null;
  /** `disabled` deactivates (revokes sessions); omit to leave unchanged. */
  readonly status?: 'active' | 'disabled';
  /** Desired membership set — replaces the current one. */
  readonly memberships?: ReadonlyArray<AdminUserMembership>;
}

/** `POST /api/v1/admin/users/{id}/resend-invite` response. */
export interface AdminUserResendInviteResponse {
  readonly user: AdminUser;
  readonly emailSent: boolean;
}
