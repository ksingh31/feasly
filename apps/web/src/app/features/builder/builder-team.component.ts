import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { BuilderState } from './builder.state';
import {
  BuilderTeamState,
  ClearBuilderTeamFeedback,
  InviteBuilderTeamUser,
  LoadBuilderTeam,
  RemoveBuilderTeamUser,
  SetBuilderTeamUserRole,
  SetBuilderTeamUserStatus,
} from './builder-team.state';
import type { BuilderTeamUser } from './builder-auth.contracts';

/**
 * Builder team page (auth/05, builder org accounts).
 *
 * Route: `/builder/team` — guarded for `builder_admin` only (see
 * `builderTeamGuard`); `builder_member` holders never see the nav link
 * and the guard redirects them to `/builder`. Shows the org's user list
 * with invite (name/email/role), deactivate/reactivate, role change, and
 * remove.
 *
 * Deactivation kills the member's session immediately (backend); removal
 * is only allowed while the invite was never accepted (backend enforces).
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-builder-team',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './builder-team.component.html',
  styleUrls: ['./builder-team.component.scss'],
})
export class BuilderTeamComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(ConfigService).get('copy').builder;

  protected readonly users = this.store.selectSignal(BuilderTeamState.users);
  protected readonly status = this.store.selectSignal(BuilderTeamState.status);
  protected readonly inviteFeedback = this.store.selectSignal(
    BuilderTeamState.inviteFeedback,
  );
  protected readonly actionError = this.store.selectSignal(BuilderTeamState.actionError);
  protected readonly updatingUserId = this.store.selectSignal(
    BuilderTeamState.updatingUserId,
  );
  protected readonly orgName = this.store.selectSignal(BuilderState.activeBuilderName);

  protected readonly inviteForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
    role: ['builder_member' as 'builder_admin' | 'builder_member', Validators.required],
  });

  /** User id awaiting confirm for deactivate/remove; null when no dialog. */
  protected confirmAction: {
    id: string;
    kind: 'deactivate' | 'remove';
  } | null = null;

  constructor() {
    this.seo.setPage({
      title: 'Team — Feasly Builder',
      description: 'Manage your builder organization team.',
      path: '/builder/team',
    });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadBuilderTeam());
  }

  protected retry(): void {
    this.store.dispatch(new LoadBuilderTeam());
  }

  protected roleLabel(role: BuilderTeamUser['role']): string {
    return role === 'builder_admin' ? this.copy.orgRoleAdmin : this.copy.orgRoleMember;
  }

  protected statusLabel(status: BuilderTeamUser['status']): string {
    switch (status) {
      case 'active':
        return this.copy.teamStatusActive;
      case 'invited':
        return this.copy.teamStatusInvited;
      case 'deactivated':
        return this.copy.teamStatusDeactivated;
    }
  }

  protected get nameInvalid(): boolean {
    const control = this.inviteForm.controls.name;
    return control.invalid && (control.dirty || control.touched);
  }

  protected get emailInvalid(): boolean {
    const control = this.inviteForm.controls.email;
    return control.invalid && (control.dirty || control.touched);
  }

  protected invite(): void {
    if (this.inviteForm.invalid) {
      this.inviteForm.markAllAsTouched();
      return;
    }
    const { name, email, role } = this.inviteForm.getRawValue();
    this.store
      .dispatch(new InviteBuilderTeamUser(name.trim(), email.trim(), role))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.store.selectSnapshot(BuilderTeamState.inviteFeedback) === 'sent') {
          this.inviteForm.reset({ role: 'builder_member' });
        }
      });
  }

  protected dismissFeedback(): void {
    this.store.dispatch(new ClearBuilderTeamFeedback());
  }

  protected askDeactivate(user: BuilderTeamUser): void {
    this.confirmAction = { id: user.id, kind: 'deactivate' };
  }

  protected askRemove(user: BuilderTeamUser): void {
    this.confirmAction = { id: user.id, kind: 'remove' };
  }

  protected cancelConfirm(): void {
    this.confirmAction = null;
  }

  protected confirmDialog(): void {
    const action = this.confirmAction;
    if (!action) return;
    this.confirmAction = null;
    if (action.kind === 'deactivate') {
      this.store.dispatch(new SetBuilderTeamUserStatus(action.id, 'deactivated'));
    } else {
      this.store.dispatch(new RemoveBuilderTeamUser(action.id));
    }
  }

  protected reactivate(user: BuilderTeamUser): void {
    this.store.dispatch(new SetBuilderTeamUserStatus(user.id, 'active'));
  }

  protected changeRole(user: BuilderTeamUser, role: 'builder_admin' | 'builder_member'): void {
    if (user.role === role) return;
    this.store.dispatch(new SetBuilderTeamUserRole(user.id, role));
  }

  protected confirmText(): string {
    return this.confirmAction?.kind === 'remove'
      ? this.copy.teamRemoveConfirm
      : this.copy.teamDeactivateConfirm;
  }
}
