import { DialogRef } from '@angular/cdk/dialog';
import { Component, DestroyRef, computed, inject } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Store } from '@ngxs/store';
import { startWith } from 'rxjs';
import type { AdminUserBuilderRole, AdminUserStaffRole } from '@feasly/contracts';
import {
  type UiSelectOption,
  UiButtonComponent,
  UiModalComponent,
  UiSelectComponent,
  UiTextFieldComponent,
} from '@app/shared/ui';
import { InviteAdminUser } from './admin-users.actions';
import { AdminUsersState } from './admin-users.state';
import { AdminBuildersState } from './admin-builders.state';
import {
  ADMIN_BUILDER_ROLE_LABELS,
  ADMIN_STAFF_ROLE_LABELS,
  ADMIN_STAFF_ROLES,
} from './admin-user-edit-drawer.component';

const BUILDER_ROLES = Object.keys(ADMIN_BUILDER_ROLE_LABELS) as AdminUserBuilderRole[];

/** Staff roles first, then builder roles (labels are distinct: "Admin" vs "Builder admin"). */
const ROLE_OPTIONS: readonly UiSelectOption[] = [
  ...ADMIN_STAFF_ROLES.map((r) => ({ value: r, label: ADMIN_STAFF_ROLE_LABELS[r] })),
  ...BUILDER_ROLES.map((r) => ({ value: r, label: ADMIN_BUILDER_ROLE_LABELS[r] })),
];

/**
 * Invite-user modal (#548). Was a hand-rolled overlay on the Users page
 * with no focus trap, no Esc and no initial focus — the admin visual-QA
 * keyboard e2e caught it. Now on the kit's `UiModalService` / `ui-modal`
 * (CDK focus trap, Esc + scrim dismissal, focus return, mobile sheet).
 *
 * The invite itself still flows through AdminUsersState (`InviteAdminUser`
 * — `inviting` / `inviteError`); the page opens and closes this modal off
 * `AdminUsersState.inviteOpen`, which the state clears on success.
 */
@Component({
  selector: 'app-admin-user-invite-modal',
  standalone: true,
  imports: [ReactiveFormsModule, UiModalComponent, UiButtonComponent, UiTextFieldComponent, UiSelectComponent],
  templateUrl: './admin-user-invite-modal.component.html',
  styleUrl: './admin-user-invite-modal.component.scss',
})
export class AdminUserInviteModalComponent {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly ref = inject<DialogRef<void>>(DialogRef);

  protected readonly inviting = this.store.selectSignal(AdminUsersState.inviting);
  protected readonly inviteError = this.store.selectSignal(AdminUsersState.inviteError);
  private readonly builders = this.store.selectSignal(AdminBuildersState.builders);

  protected readonly roleOptions = ROLE_OPTIONS;
  protected readonly builderOptions = computed<readonly UiSelectOption[]>(() =>
    this.builders().map((b) => ({ value: b.id, label: b.displayName })),
  );

  /** Invite form: email, name, role, and (for builder roles) the org. */
  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    name: ['', [Validators.required, Validators.maxLength(200)]],
    role: ['viewer' as string | null, [Validators.required]],
    builderId: [null as string | null],
  });

  private readonly role = toSignal(
    this.form.controls.role.valueChanges.pipe(startWith(this.form.controls.role.value)),
    { initialValue: this.form.controls.role.value },
  );

  /** Builder roles need an organization. */
  protected readonly roleIsBuilder = computed(() =>
    (BUILDER_ROLES as readonly (string | null)[]).includes(this.role()),
  );

  protected error(name: 'email' | 'name' | 'builderId'): string | null {
    const control = this.form.controls[name];
    if (!control.touched || control.valid) return null;
    switch (name) {
      case 'email':
        return 'Enter a valid email address.';
      case 'name':
        return "Enter the person's name.";
      case 'builderId':
        return 'Choose the builder organization.';
    }
  }

  protected cancel(): void {
    this.ref.close();
  }

  protected submit(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.inviting()) return;
    const { email, name, role, builderId } = this.form.getRawValue();
    const builder = this.roleIsBuilder();
    if (builder && !builderId) {
      this.form.controls.builderId.setErrors({ required: true });
      return;
    }
    this.store
      .dispatch(
        new InviteAdminUser({
          email: email.trim(),
          name: name.trim(),
          role: role as AdminUserStaffRole | AdminUserBuilderRole,
          builderId: builder && builderId ? builderId : undefined,
        }),
      )
      // Success clears `inviteOpen` and the page closes the modal; a
      // failure leaves it open with `inviteError` shown inline.
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ error: () => undefined });
  }
}
