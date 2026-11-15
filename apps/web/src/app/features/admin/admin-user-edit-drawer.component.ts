import { DIALOG_DATA } from '@angular/cdk/dialog';
import { Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  FormRecord,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Store } from '@ngxs/store';
import type {
  AdminUser,
  AdminUserBuilderRole,
  AdminUserMembership,
  AdminUserStaffRole,
  AdminUserUpdateBody,
} from '@feasly/contracts';
import {
  StatusChipComponent,
  UiButtonComponent,
  UiDrawerComponent,
  UiDrawerRef,
} from '@app/shared/ui';
import { InfoTooltipComponent } from '../../shared/components/info-tooltip';
import { UpdateAdminUser } from './admin-users.actions';
import { AdminUsersState } from './admin-users.state';
import { AdminBuildersState } from './admin-builders.state';

/** What the Users page hands the edit drawer. */
export interface AdminUserEditDrawerData {
  readonly userId: string;
  /**
   * auth/07: the user is the sole remaining active staff admin — the staff
   * role select is locked with an ⓘ explainer (the backend 409 is the real
   * enforcement).
   */
  readonly lockStaffRole: boolean;
}

export const ADMIN_STAFF_ROLES: readonly AdminUserStaffRole[] = ['super_admin', 'admin', 'viewer'];

export const ADMIN_STAFF_ROLE_LABELS: Readonly<Record<AdminUserStaffRole, string>> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  viewer: 'Viewer',
};

export const ADMIN_BUILDER_ROLE_LABELS: Readonly<Record<AdminUserBuilderRole, string>> = {
  builder_admin: 'Builder admin',
  builder_member: 'Builder member',
};

type MembershipGroup = FormGroup<{
  member: FormControl<boolean>;
  role: FormControl<AdminUserBuilderRole>;
}>;

/**
 * Edit a team user — review 2026-11-13 S8 ("one modal, one save", #542).
 *
 * One form in a `ui-drawer`: name, staff role and builder-organization
 * memberships, with one sticky footer [Cancel] [Save]. Save sends a single
 * PATCH carrying only the fields that changed (memberships only when the
 * set or a role actually differs — the backend refuses self-membership
 * edits, so an untouched set must never be sent). Esc / scrim / × / Cancel
 * ask before discarding unsaved edits (drawer dirty guard).
 *
 * The drawer closes itself on a successful save; a failure keeps it open
 * with the backend's message above the footer.
 */
@Component({
  selector: 'app-admin-user-edit-drawer',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    UiDrawerComponent,
    UiButtonComponent,
    StatusChipComponent,
    InfoTooltipComponent,
  ],
  templateUrl: './admin-user-edit-drawer.component.html',
  styleUrls: ['./admin-user-edit-drawer.component.scss'],
})
export class AdminUserEditDrawerComponent {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly ref = inject<UiDrawerRef<boolean>>(UiDrawerRef);
  protected readonly data = inject<AdminUserEditDrawerData>(DIALOG_DATA);

  protected readonly updating = this.store.selectSignal(AdminUsersState.updating);
  protected readonly updateError = this.store.selectSignal(AdminUsersState.updateError);
  protected readonly builders = this.store.selectSignal(AdminBuildersState.builders);

  /** The user as loaded when the drawer opened — the baseline for "changed". */
  protected readonly user: AdminUser | null =
    this.store.selectSnapshot(AdminUsersState.users).find((u) => u.id === this.data.userId) ?? null;

  protected readonly staffRoles = ADMIN_STAFF_ROLES;
  protected readonly staffRoleLabels = ADMIN_STAFF_ROLE_LABELS;
  protected readonly builderRoleLabels = ADMIN_BUILDER_ROLE_LABELS;
  protected readonly builderRoles = Object.keys(ADMIN_BUILDER_ROLE_LABELS) as AdminUserBuilderRole[];
  protected readonly roleTipId = `last-admin-role-${this.data.userId}`;

  /** The one form: name + staff role + one {member, role} group per builder org. */
  protected readonly form = this.fb.nonNullable.group({
    name: [this.user?.name ?? '', [Validators.required, Validators.maxLength(200)]],
    role: [(this.user?.staffRole ?? '') as AdminUserStaffRole | ''],
    memberships: new FormRecord<MembershipGroup>({}),
  });

  constructor() {
    const current = this.user?.memberships ?? [];
    for (const b of this.builders()) {
      const existing = current.find((m) => m.builderId === b.id);
      this.form.controls.memberships.addControl(
        b.id,
        this.fb.nonNullable.group({
          member: [!!existing],
          role: [existing?.role ?? ('builder_member' as AdminUserBuilderRole)],
        }),
      );
    }
    if (this.data.lockStaffRole) this.form.controls.role.disable();
  }

  protected membership(builderId: string): MembershipGroup | null {
    return this.form.controls.memberships.controls[builderId] ?? null;
  }

  protected save(): void {
    const user = this.user;
    if (!user || this.updating()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const body = this.changes(user);
    if (Object.keys(body).length === 0) {
      this.ref.close(false);
      return;
    }
    this.store
      .dispatch(new UpdateAdminUser(user.id, body))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.ref.close(true),
        // The state holds the message; the drawer stays open to show it.
        error: () => undefined,
      });
  }

  protected cancel(): void {
    this.ref.requestClose();
  }

  /** Only the fields that differ from the loaded user. */
  private changes(user: AdminUser): AdminUserUpdateBody {
    const { name, role } = this.form.getRawValue();
    const trimmedName = name.trim();
    // An empty role keeps a builder-only user builder-only; null strips it.
    const staffRole = role === '' ? null : role;
    const memberships = this.desiredMemberships();
    return {
      ...(trimmedName !== user.name ? { name: trimmedName } : {}),
      ...(!this.data.lockStaffRole && staffRole !== (user.staffRole ?? null) ? { staffRole } : {}),
      ...(membershipsDiffer(memberships, user.memberships) ? { memberships } : {}),
    };
  }

  private desiredMemberships(): AdminUserMembership[] {
    const groups = this.form.controls.memberships.controls;
    const known = new Set(Object.keys(groups));
    const chosen = Object.entries(groups)
      .filter(([, g]) => g.controls.member.value)
      .map(([builderId, g]) => ({ builderId, role: g.controls.role.value }));
    // Memberships in orgs not in the loaded builder list are kept as-is.
    const unseen = (this.user?.memberships ?? []).filter((m) => !known.has(m.builderId));
    return [...unseen.map((m) => ({ builderId: m.builderId, role: m.role })), ...chosen];
  }
}

function membershipsDiffer(
  a: readonly AdminUserMembership[],
  b: readonly AdminUserMembership[],
): boolean {
  if (a.length !== b.length) return true;
  const key = (m: AdminUserMembership) => `${m.builderId}:${m.role}`;
  const set = new Set(b.map(key));
  return a.some((m) => !set.has(key(m)));
}
