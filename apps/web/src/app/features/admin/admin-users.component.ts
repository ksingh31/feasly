import { Component, inject, OnInit } from '@angular/core';
import {
  FormBuilder,
  FormControl,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Store } from '@ngxs/store';
import type {
  AdminUser,
  AdminUserBuilderRole,
  AdminUserStaffRole,
  AdminUserStatus,
  AdminUserUpdateBody,
  Builder,
} from '@feasly/contracts';
import {
  CloseDeleteAdminUser,
  CloseEditAdminUser,
  CloseInviteAdminUser,
  DeactivateAdminUser,
  DeleteAdminUser,
  DismissAdminUsersNotice,
  InviteAdminUser,
  LoadAdminUsers,
  OpenDeleteAdminUser,
  OpenEditAdminUser,
  OpenInviteAdminUser,
  ReactivateAdminUser,
  ResendAdminUserInvite,
  UpdateAdminUser,
} from './admin-users.actions';
import { AdminUsersState } from './admin-users.state';
import { AdminAuthState } from './admin-auth.state';
import { AdminBuildersState } from './admin-builders.state';
import { LoadBuilders } from './admin-builders.actions';
import { InfoTooltipComponent } from '../../shared/components/info-tooltip';

const STAFF_ROLES = ['super_admin', 'admin', 'viewer'] as const;
const BUILDER_ROLES: readonly AdminUserBuilderRole[] = [
  'builder_admin',
  'builder_member',
];

/**
 * Admin user management (auth/03) — the team-user table.
 *
 * Invite by email (provisions their Entra account + emails a branded
 * invite), edit name/role/org memberships, deactivate/reactivate (sessions
 * are revoked immediately server-side), resend invites, and delete users
 * that never accepted their invite. Every mutation is audit-logged
 * server-side; guard failures surface the backend's plain-English message.
 *
 * The protected seed account and the current admin's own row refuse
 * dangerous actions with an explanatory note.
 *
 * Guarded by `adminGuard`; noindex via the robots guard; lazy-loaded so it
 * stays out of the public initial bundle. All state lives in
 * `AdminUsersState` — the component only dispatches actions and reads
 * signals. Builder org options come from `AdminBuildersState`.
 */
@Component({
  selector: 'app-admin-users',
  standalone: true,
  imports: [ReactiveFormsModule, InfoTooltipComponent],
  templateUrl: './admin-users.component.html',
  styleUrls: ['./admin-users.component.scss'],
})
export class AdminUsersComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);

  protected readonly users = this.store.selectSignal(AdminUsersState.users);
  protected readonly total = this.store.selectSignal(AdminUsersState.total);
  protected readonly listStatus = this.store.selectSignal(AdminUsersState.listStatus);
  protected readonly listError = this.store.selectSignal(AdminUsersState.listError);
  protected readonly inviteOpen = this.store.selectSignal(AdminUsersState.inviteOpen);
  protected readonly inviting = this.store.selectSignal(AdminUsersState.inviting);
  protected readonly inviteError = this.store.selectSignal(AdminUsersState.inviteError);
  protected readonly editingId = this.store.selectSignal(AdminUsersState.editingId);
  protected readonly updating = this.store.selectSignal(AdminUsersState.updating);
  protected readonly updateError = this.store.selectSignal(AdminUsersState.updateError);
  /**
   * auth/07: the table row a failed row action targeted — its 409 surfaces
   * inline on that row, never as a generic banner.
   */
  protected readonly updateErrorUserId = this.store.selectSignal(
    AdminUsersState.updateErrorUserId,
  );
  protected readonly deletingId = this.store.selectSignal(AdminUsersState.deletingId);
  protected readonly deleting = this.store.selectSignal(AdminUsersState.deleting);
  protected readonly deleteError = this.store.selectSignal(AdminUsersState.deleteError);
  protected readonly resendingId = this.store.selectSignal(AdminUsersState.resendingId);
  /** Lowercased email the admin session was issued for — marks the self row. */
  protected readonly selfEmail = this.store.selectSignal(AdminAuthState.email);
  protected readonly notice = this.store.selectSignal(AdminUsersState.notice);
  protected readonly builders = this.store.selectSignal(AdminBuildersState.builders);

  /** Invite form: email, name, role, and (for builder roles) the org. */
  protected readonly inviteForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    name: ['', [Validators.required, Validators.maxLength(200)]],
    role: ['viewer' as string, [Validators.required]],
    builderId: [''],
  });

  /** Edit form: name + staff role. Memberships are edited via the checkbox list. */
  protected readonly editForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(200)]],
    role: [''],
  });

  /** Delete confirmation: type the user's email to confirm. */
  protected readonly deleteForm = this.fb.nonNullable.group({
    confirmation: [''],
  });

  protected readonly staffRoles = STAFF_ROLES;
  protected readonly builderRoles = BUILDER_ROLES;

  ngOnInit(): void {
    this.store.dispatch([new LoadAdminUsers(), new LoadBuilders()]);
  }

  // ------------------------------------------------------------- invite

  protected openInvite(): void {
    this.inviteForm.reset({ email: '', name: '', role: 'viewer', builderId: '' });
    this.store.dispatch(new OpenInviteAdminUser());
  }

  protected closeInvite(): void {
    this.store.dispatch(new CloseInviteAdminUser());
  }

  protected inviteRoleIsBuilder(): boolean {
    const role = this.inviteForm.controls.role.value;
    return (BUILDER_ROLES as readonly string[]).includes(role);
  }

  protected submitInvite(): void {
    if (this.inviteForm.invalid || this.inviting()) {
      this.inviteForm.markAllAsTouched();
      return;
    }
    const { email, name, role, builderId } = this.inviteForm.getRawValue();
    if (this.inviteRoleIsBuilder() && !builderId) {
      this.inviteForm.controls.builderId.setErrors({ required: true });
      this.inviteForm.controls.builderId.markAsTouched();
      return;
    }
    this.store.dispatch(
      new InviteAdminUser({
        email: email.trim(),
        name: name.trim(),
        role: role as AdminUserStaffRole | AdminUserBuilderRole,
        builderId: this.inviteRoleIsBuilder() && builderId ? builderId : undefined,
      }),
    );
  }

  // --------------------------------------------------------------- edit

  protected openEdit(user: AdminUser): void {
    this.editDrawerControls.clear();
    this.editDrawerRoleControls.clear();
    this.editForm.reset({ name: user.name, role: user.staffRole ?? '' });
    // auth/07: the sole remaining active staff admin's role is locked by
    // the backend 409 — disable the select up front with an explainer.
    if (this.isSoleStaffAdmin(user)) {
      this.editForm.controls.role.disable();
    } else {
      this.editForm.controls.role.enable();
    }
    this.store.dispatch(new OpenEditAdminUser(user.id));
  }

  protected closeEdit(): void {
    this.store.dispatch(new CloseEditAdminUser());
  }

  protected editingUser(): AdminUser | null {
    const id = this.editingId();
    return this.users().find((u) => u.id === id) ?? null;
  }

  protected editRoleIsBuilder(): boolean {
    const role = this.editForm.controls.role.value;
    return (BUILDER_ROLES as readonly string[]).includes(role);
  }

  protected submitEdit(): void {
    const user = this.editingUser();
    if (!user || this.editForm.invalid || this.updating()) {
      this.editForm.markAllAsTouched();
      return;
    }
    const { name, role } = this.editForm.getRawValue();
    // An empty role keeps a builder-only user builder-only (no staff role
    // is granted by accident); a chosen role only changes when it differs.
    // Passing null strips the staff role entirely.
    const trimmedName = name.trim();
    const staffRole = role === '' ? null : (role as AdminUserStaffRole);
    const body: AdminUserUpdateBody = {
      ...(trimmedName !== user.name ? { name: trimmedName } : {}),
      ...(staffRole !== (user.staffRole ?? null) ? { staffRole } : {}),
    };
    if (Object.keys(body).length === 0) {
      this.closeEdit();
      return;
    }
    this.store.dispatch(new UpdateAdminUser(user.id, body));
  }

  /** Membership checkboxes in the edit drawer: one FormControl per builder. */
  protected membershipControl(builderId: string): FormControl<boolean> {
    const key = `membership-${builderId}`;
    let control = this.editDrawerControls.get(key);
    if (!control) {
      const user = this.editingUser();
      control = this.fb.nonNullable.control(
        user?.memberships.some((m) => m.builderId === builderId) ?? false,
      );
      this.editDrawerControls.set(key, control);
    }
    return control;
  }

  /** Membership role select in the edit drawer: one per builder. */
  protected membershipRoleControl(
    builderId: string,
  ): FormControl<AdminUserBuilderRole> {
    const key = `membership-role-${builderId}`;
    let control = this.editDrawerRoleControls.get(key);
    if (!control) {
      const user = this.editingUser();
      control = this.fb.nonNullable.control<AdminUserBuilderRole>(
        user?.memberships.find((m) => m.builderId === builderId)?.role ??
          'builder_member',
      );
      this.editDrawerRoleControls.set(key, control);
    }
    return control;
  }

  private readonly editDrawerControls = new Map<string, FormControl<boolean>>();
  private readonly editDrawerRoleControls = new Map<
    string,
    FormControl<AdminUserBuilderRole>
  >();

  protected submitMemberships(): void {
    const user = this.editingUser();
    if (!user || this.updating()) {
      return;
    }
    const memberships = this.builders()
      .filter((b) => this.membershipControl(b.id).value)
      .map((b) => ({
        builderId: b.id,
        role: this.membershipRoleControl(b.id).value,
      }));
    this.store.dispatch(new UpdateAdminUser(user.id, { memberships }));
  }

  // ------------------------------------------------- activate / delete

  protected deactivate(user: AdminUser): void {
    this.store.dispatch(new DeactivateAdminUser(user.id));
  }

  protected reactivate(user: AdminUser): void {
    this.store.dispatch(new ReactivateAdminUser(user.id));
  }

  protected resendInvite(user: AdminUser): void {
    this.store.dispatch(new ResendAdminUserInvite(user.id));
  }

  protected openDelete(user: AdminUser): void {
    this.deleteForm.reset({ confirmation: '' });
    this.store.dispatch(new OpenDeleteAdminUser(user.id));
  }

  protected closeDelete(): void {
    this.store.dispatch(new CloseDeleteAdminUser());
  }

  protected deletingUser(): AdminUser | null {
    const id = this.deletingId();
    return this.users().find((u) => u.id === id) ?? null;
  }

  protected deleteConfirmationMatches(): boolean {
    const user = this.deletingUser();
    return (
      !!user &&
      this.deleteForm.controls.confirmation.value.trim().toLowerCase() ===
        user.email.toLowerCase()
    );
  }

  protected confirmDelete(): void {
    const user = this.deletingUser();
    if (!user || !this.deleteConfirmationMatches() || this.deleting()) {
      return;
    }
    this.store.dispatch(new DeleteAdminUser(user.id));
  }

  protected dismissNotice(): void {
    this.store.dispatch(new DismissAdminUsersNotice());
  }

  protected reload(): void {
    this.store.dispatch(new LoadAdminUsers());
  }

  // -------------------------------------------------------------- labels

  protected roleLabel(user: AdminUser): string {
    if (user.staffRole) {
      return (
        { super_admin: 'Super admin', admin: 'Admin', viewer: 'Viewer' } as const
      )[user.staffRole];
    }
    return user.memberships
      .map((m) => (m.role === 'builder_admin' ? 'Builder admin' : 'Builder member'))
      .join(', ');
  }

  protected statusLabel(status: AdminUserStatus): string {
    return (
      { active: 'Active', invited: 'Invited', disabled: 'Disabled' } as const
    )[status];
  }

  protected builderName(builderId: string): string {
    const builders: Builder[] = this.builders();
    return (
      builders.find((b) => b.id === builderId)?.displayName ?? builderId
    );
  }

  protected canEdit(user: AdminUser): boolean {
    return !user.isProtected;
  }

  protected canToggleActive(user: AdminUser): boolean {
    return !user.isProtected && user.status !== 'invited';
  }

  /** Whether this row is the signed-in admin (self-harm is blocked server-side). */
  protected isSelf(user: AdminUser): boolean {
    const self = this.selfEmail();
    return self !== null && user.email.toLowerCase() === self;
  }

  protected canDelete(user: AdminUser): boolean {
    // Delete is only ever allowed before the invite is accepted.
    return !user.isProtected && user.status === 'invited';
  }

  /**
   * Deterministic id for a last-admin ⓘ tooltip bubble. The disabled
   * control's `aria-describedby` and the tooltip's `[tooltipId]` both
   * use it (template refs can't cross `@if` block boundaries).
   */
  protected lastAdminTipId(user: AdminUser | null, kind: 'role' | 'deactivate'): string {
    return `last-admin-${kind}-${user?.id ?? 'unknown'}`;
  }

  /**
   * auth/07: whether this row is the sole remaining active staff admin
   * (`super_admin`/`admin`) in the loaded list. The template disables
   * their staff-role select and their Deactivate action, with an ⓘ
   * tooltip explainer; the backend 409 is the real enforcement. Pending /
   * deactivated users never count. (The list is paginated, so an admin
   * on another page isn't visible here — the 409 still protects them.)
   */
  protected isSoleStaffAdmin(user: AdminUser | null): boolean {
    if (
      !user ||
      (user.staffRole !== 'super_admin' && user.staffRole !== 'admin') ||
      user.status !== 'active'
    ) {
      return false;
    }
    const admins = this.users().filter(
      (u) =>
        (u.staffRole === 'super_admin' || u.staffRole === 'admin') &&
        u.status === 'active',
    );
    return admins.length === 1 && admins[0]!.id === user.id;
  }
}
