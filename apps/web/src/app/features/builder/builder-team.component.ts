import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
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
 * and the guard redirects them to `/builder`. The component additionally
 * gates defensively: the invite form, role select, and row actions render
 * only for builder admins (`BuilderState.isBuilderAdmin()`); a non-admin
 * who somehow lands here gets a read-only table plus a notice.
 *
 * Admin design language (admin-users.component.*): header + invite button,
 * banner, skeleton rows, table (name/email/role/status/added/actions),
 * empty state, error + retry, invite and confirm modals.
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
  /**
   * Defensive admin gate: the route guard already blocks non-admins, and
   * the shell hides the nav — but the invite form, role select, and row
   * actions render only behind this signal too, so a tampered route state
   * can never surface manage controls to a builder_member.
   */
  protected readonly isBuilderAdmin = this.store.selectSignal(BuilderState.isBuilderAdmin);

  readonly inviteForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
    role: ['builder_member' as 'builder_admin' | 'builder_member', Validators.required],
  });

  /** User id awaiting confirm for deactivate/remove; null when no dialog. */
  protected confirmAction: {
    id: string;
    kind: 'deactivate' | 'remove';
  } | null = null;

  /** Invite modal open state; only ever opened behind the admin gate. */
  protected inviteOpen = false;

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

  /** Buyer-grade added date (e.g. "Sep 28, 2026"); '—' when missing. */
  protected addedDate(user: BuilderTeamUser): string {
    if (!user.createdAt) return '—';
    const parsed = new Date(user.createdAt);
    if (Number.isNaN(parsed.getTime())) return '—';
    return parsed.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  protected openInvite(): void {
    if (!this.store.selectSnapshot(BuilderState.isBuilderAdmin)) return;
    this.inviteOpen = true;
  }

  protected closeInvite(): void {
    this.inviteOpen = false;
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
          this.inviteOpen = false;
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

  /**
   * Pending (unapplied) role selections, keyed by user id. Selecting a
   * role never saves — it only stages the choice; the Apply button
   * performs the actual update. Karan's explicit order (2026-09-29): no
   * auto-save on selection anywhere in the app.
   */
  protected readonly pendingRole = signal<
    Record<string, 'builder_admin' | 'builder_member'>
  >({});

  /** The value the role select renders: the pending pick, or the stored role. */
  protected pendingRoleFor(
    user: BuilderTeamUser,
  ): 'builder_admin' | 'builder_member' {
    return this.pendingRole()[user.id] ?? user.role;
  }

  /**
   * The Apply button is enabled only when the staged role differs from
   * the stored role and no save is in flight.
   */
  protected canApplyRole(user: BuilderTeamUser): boolean {
    return (
      this.pendingRoleFor(user) !== user.role &&
      this.updatingUserId() === null
    );
  }

  /** Stages a role choice without saving (template-bound). */
  protected onRoleSelect(userId: string, value: string): void {
    const role = value as 'builder_admin' | 'builder_member';
    this.pendingRole.update((pending) => ({ ...pending, [userId]: role }));
  }

  /**
   * Saves the staged role (Apply button, template-bound). Clears the
   * staged choice on completion — on failure the select reverts to the
   * stored role so the UI can never disagree with the backend.
   */
  protected applyRole(user: BuilderTeamUser): void {
    const pending = this.pendingRole()[user.id];
    if (pending === undefined || pending === user.role) {
      this.clearPendingRole(user.id);
      return;
    }
    this.store
      .dispatch(new SetBuilderTeamUserRole(user.id, pending))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.clearPendingRole(user.id));
  }

  private clearPendingRole(userId: string): void {
    this.pendingRole.update((pending) => {
      if (!(userId in pending)) {
        return pending;
      }
      const next = { ...pending };
      delete next[userId];
      return next;
    });
  }

  protected confirmText(): string {
    return this.confirmAction?.kind === 'remove'
      ? this.copy.teamRemoveConfirm
      : this.copy.teamDeactivateConfirm;
  }
}
