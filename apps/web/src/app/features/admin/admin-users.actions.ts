import type {
  AdminUserBuilderRole,
  AdminUserInviteBody,
  AdminUserStaffRole,
  AdminUserUpdateBody,
} from '@feasly/contracts';

/** Reload the team-user list from the backend. */
export class LoadAdminUsers {
  static readonly type = '[AdminUsers] Load';
}

/** Open the invite modal. */
export class OpenInviteAdminUser {
  static readonly type = '[AdminUsers] Open invite';
}

/** Close the invite modal (and clear its error). */
export class CloseInviteAdminUser {
  static readonly type = '[AdminUsers] Close invite';
}

/** Invite a user by email. Audit-logged server-side. */
export class InviteAdminUser {
  static readonly type = '[AdminUsers] Invite';
  constructor(readonly body: AdminUserInviteBody) {}
}

/** Open the edit drawer for a user (role, name, org memberships). */
export class OpenEditAdminUser {
  static readonly type = '[AdminUsers] Open edit';
  constructor(readonly id: string) {}
}

/** Close the edit drawer (and clear its error). */
export class CloseEditAdminUser {
  static readonly type = '[AdminUsers] Close edit';
}

/** Rename, change role, toggle active/disabled, or replace memberships. */
export class UpdateAdminUser {
  static readonly type = '[AdminUsers] Update';
  constructor(
    readonly id: string,
    readonly body: AdminUserUpdateBody,
  ) {}
}

/** Convenience wrapper: deactivate a user (their sessions are revoked immediately). */
export class DeactivateAdminUser {
  static readonly type = '[AdminUsers] Deactivate';
  constructor(readonly id: string) {}
}

/** Convenience wrapper: reactivate a disabled user. */
export class ReactivateAdminUser {
  static readonly type = '[AdminUsers] Reactivate';
  constructor(readonly id: string) {}
}

/** Open the delete confirmation (delete is only allowed pre-acceptance). */
export class OpenDeleteAdminUser {
  static readonly type = '[AdminUsers] Open delete';
  constructor(readonly id: string) {}
}

/** Close the delete confirmation. */
export class CloseDeleteAdminUser {
  static readonly type = '[AdminUsers] Close delete';
}

/** Hard-delete a never-accepted user. Audit-logged server-side. */
export class DeleteAdminUser {
  static readonly type = '[AdminUsers] Delete';
  constructor(readonly id: string) {}
}

/** Resend the invitation email to a pending user. */
export class ResendAdminUserInvite {
  static readonly type = '[AdminUsers] Resend invite';
  constructor(readonly id: string) {}
}

/** Dismiss the success/error toast banner. */
export class DismissAdminUsersNotice {
  static readonly type = '[AdminUsers] Dismiss notice';
}

/** Staff roles assignable through the UI. */
export type AdminUserStaffRoleOption = AdminUserStaffRole;

/** Builder roles assignable through the UI. */
export type AdminUserBuilderRoleOption = AdminUserBuilderRole;
