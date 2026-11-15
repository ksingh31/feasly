import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Store } from '@ngxs/store';
import { filter, switchMap } from 'rxjs';
import { StatusChipComponent, UiConfirmService, UiToastService } from '@app/shared/ui';
import { SeoService } from '../../core/seo/seo.service';
import { InfoTooltipComponent } from '../../shared/components/info-tooltip';
import { BUILDER_COPY } from './builder-copy';
import { ActivateBuilderViewAs } from './builder.actions';
import { BuilderState } from './builder.state';
import {
  BuilderTeamState,
  ClearBuilderTeamFeedback,
  InviteBuilderTeamUser,
  LoadBuilderTeam,
  RemoveBuilderTeamUser,
  ResendBuilderTeamInvite,
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
 * Team v2 (#535, review 2026-11-13 Should-fix 6): the signed-in user's row
 * carries a "You" tag and no manage controls; pending invites offer only
 * Resend + Revoke; deactivated rows are greyed with no role select;
 * Deactivate and Revoke confirm in the shared ConfirmDialog and report in
 * a toast. On phones each row stacks into a card with no horizontal scroll.
 *
 * Deactivation kills the member's session immediately (backend); revoking
 * is only allowed while the invite was never accepted (backend enforces).
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-builder-team',
  standalone: true,
  imports: [ReactiveFormsModule, InfoTooltipComponent, StatusChipComponent],
  templateUrl: './builder-team.component.html',
  styleUrls: ['./builder-team.component.scss'],
})
export class BuilderTeamComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirms = inject(UiConfirmService);
  private readonly toasts = inject(UiToastService);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(BUILDER_COPY);

  protected readonly users = this.store.selectSignal(BuilderTeamState.users);
  protected readonly status = this.store.selectSignal(BuilderTeamState.status);
  protected readonly inviteFeedback = this.store.selectSignal(
    BuilderTeamState.inviteFeedback,
  );
  /** Invite request in flight — disables the submit button (busy guard). */
  protected readonly inviting = this.store.selectSignal(
    BuilderTeamState.inviting,
  );
  /** The API's own message for a failed invite — shown inline in the dialog. */
  protected readonly inviteError = this.store.selectSignal(
    BuilderTeamState.inviteError,
  );
  protected readonly actionError = this.store.selectSignal(BuilderTeamState.actionError);
  /** The API's own message for a failed row action, when one was given. */
  protected readonly actionErrorMessage = this.store.selectSignal(
    BuilderTeamState.actionErrorMessage,
  );
  /**
   * auth/07: the row a failed action targeted — its 409 surfaces inline on
   * that row, never as a generic banner.
   */
  protected readonly actionErrorUserId = this.store.selectSignal(
    BuilderTeamState.actionErrorUserId,
  );
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

  /**
   * Builder-side view-as (2026-09-30, Karan): true for a builder_admin
   * who is not already viewing-as. The "View as" row buttons render only
   * behind this — the backend enforces the same rules (plus the #394
   * admin-target lockdown) regardless of what the UI shows.
   */
  protected readonly canInitiateViewAs = this.store.selectSignal(
    BuilderState.canInitiateViewAs,
  );
  /** True while a view-as activate/exit request is in flight. */
  protected readonly viewAsBusy = this.store.selectSignal(BuilderState.viewAsBusy);
  /** Last view-as failure bucket ('forbidden' | 'failed' | null). */
  protected readonly viewAsError = this.store.selectSignal(BuilderState.viewAsError);
  /** Id of the row whose view-as activation is in flight (per-row busy). */
  protected readonly viewAsStartingUserId = signal<string | null>(null);
  /**
   * Id of the last row targeted by view-as — the failure note renders on
   * this row (never as a generic banner).
   */
  protected readonly viewAsLastTargetUserId = signal<string | null>(null);
  /** The signed-in session — used to exclude "view as yourself". */
  protected readonly builderSession = this.store.selectSignal(BuilderState.session);

  readonly inviteForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
    role: ['builder_member' as 'builder_admin' | 'builder_member', Validators.required],
  });

  /** Invite modal open state; only ever opened behind the admin gate. */
  protected inviteOpen = false;

  /**
   * Client-side duplicate: the typed email is already on the loaded team
   * list, so no API call is made — the inline message explains why.
   */
  protected readonly duplicateInviteError = signal<string | null>(null);

  constructor() {
    this.seo.setPage({
      title: 'Team — Feasly Builder',
      description: 'Manage your builder organization team.',
      path: '/builder/team',
    });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadBuilderTeam());
    // A stale duplicate warning must not survive the user fixing the email.
    this.inviteForm.controls.email.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.duplicateInviteError.set(null));
  }

  protected retry(): void {
    this.store.dispatch(new LoadBuilderTeam());
  }

  protected roleLabel(role: BuilderTeamUser['role']): string {
    return role === 'builder_admin' ? this.copy.orgRoleAdmin : this.copy.orgRoleMember;
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
    this.duplicateInviteError.set(null);
    this.store.dispatch(new ClearBuilderTeamFeedback());
    this.inviteOpen = true;
  }

  protected closeInvite(): void {
    this.duplicateInviteError.set(null);
    this.inviteOpen = false;
  }

  protected invite(): void {
    // Busy guard: an in-flight invite swallows repeat taps — the button is
    // also disabled, but the ngSubmit path can fire without it.
    if (this.inviteForm.invalid || this.inviting()) {
      this.inviteForm.markAllAsTouched();
      return;
    }
    const { name, email, role } = this.inviteForm.getRawValue();
    const normalizedEmail = email.trim().toLowerCase();
    // Client-side duplicate check: the email is already on the loaded team
    // list — explain inline instead of calling the API (the backend 409 is
    // the enforcement; this is the fast path).
    const existing = this.users().find(
      (user) => user.email.toLowerCase() === normalizedEmail,
    );
    if (existing) {
      this.duplicateInviteError.set(
        existing.status === 'invited'
          ? this.copy.teamInviteDuplicatePending
          : this.copy.teamInviteDuplicateMember,
      );
      return;
    }
    this.duplicateInviteError.set(null);
    this.store
      .dispatch(new InviteBuilderTeamUser(name.trim(), normalizedEmail, role))
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

  /** True for the signed-in user's own row ("You" tag, no manage controls). */
  protected isSelf(user: BuilderTeamUser): boolean {
    const selfEmail = this.builderSession()?.email?.toLowerCase() ?? null;
    return selfEmail !== null && user.email.toLowerCase() === selfEmail;
  }

  /**
   * Role select renders only for admins, on rows they can change: never
   * their own (the backend refuses self-changes) and never a deactivated
   * member (greyed row, role as text).
   */
  protected canEditRole(user: BuilderTeamUser): boolean {
    return this.isBuilderAdmin() && !this.isSelf(user) && user.status !== 'deactivated';
  }

  /** Deactivate — destructive, so it goes through the shared ConfirmDialog. */
  protected askDeactivate(user: BuilderTeamUser): void {
    if (this.rowActionsDisabled() || this.isSoleAdmin(user)) return;
    this.confirmThen(
      {
        title: this.fill(this.copy.teamDeactivateTitle, user),
        body: this.copy.teamDeactivateBody,
        verb: this.copy.teamDeactivateLabel,
      },
      new SetBuilderTeamUserStatus(user.id, 'deactivated'),
      user,
      this.copy.teamDeactivated,
    );
  }

  /** Revoke a pending invite — destructive, confirmed in the ConfirmDialog. */
  protected askRevoke(user: BuilderTeamUser): void {
    if (this.rowActionsDisabled()) return;
    this.confirmThen(
      {
        title: this.fill(this.copy.teamRevokeTitle, user),
        body: this.copy.teamRevokeBody,
        verb: this.copy.teamRevokeLabel,
      },
      new RemoveBuilderTeamUser(user.id),
      user,
      this.copy.teamRevoked,
    );
  }

  /** Re-send a pending invite (not destructive — no confirm), toast on success. */
  protected resend(user: BuilderTeamUser): void {
    if (this.rowActionsDisabled()) return;
    this.store
      .dispatch(new ResendBuilderTeamInvite(user.id))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.toastIfSucceeded(user, this.copy.teamResent));
  }

  protected reactivate(user: BuilderTeamUser): void {
    if (this.rowActionsDisabled()) return;
    this.store
      .dispatch(new SetBuilderTeamUserStatus(user.id, 'active'))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.toastIfSucceeded(user, this.copy.teamReactivated));
  }

  private confirmThen(
    options: { title: string; body: string; verb: string },
    action: SetBuilderTeamUserStatus | RemoveBuilderTeamUser,
    user: BuilderTeamUser,
    successTemplate: string,
  ): void {
    this.confirms
      .confirm({ ...options, tone: 'danger', cancelLabel: this.copy.teamConfirmNo })
      .pipe(
        filter(Boolean),
        switchMap(() => this.store.dispatch(action)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.toastIfSucceeded(user, successTemplate));
  }

  /** Failures stay inline on the row (auth/07); only success toasts. */
  private toastIfSucceeded(user: BuilderTeamUser, template: string): void {
    const failed =
      this.store.selectSnapshot(BuilderTeamState.actionError) &&
      this.store.selectSnapshot(BuilderTeamState.actionErrorUserId) === user.id;
    if (!failed) this.toasts.show({ message: this.fill(template, user) });
  }

  /** Fills `{name}` / `{email}` placeholders in a copy template. */
  protected fill(template: string, user: BuilderTeamUser): string {
    return template.replace('{name}', user.name).replace('{email}', user.email);
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
   * auth/07: whether this row is the sole remaining active admin of the
   * org. Pending/deactivated members never count — only live access
   * (status 'active') holding 'builder_admin'. The template disables
   * their role select + Apply and their Deactivate action, with an ⓘ
   * tooltip explainer; the backend 409 is the real enforcement.
   */
  protected isSoleAdmin(user: BuilderTeamUser): boolean {
    if (user.role !== 'builder_admin' || user.status !== 'active') {
      return false;
    }
    const admins = this.users().filter(
      (u) => u.role === 'builder_admin' && u.status === 'active',
    );
    return admins.length === 1 && admins[0]!.id === user.id;
  }

  /**
   * Deterministic id for the row's last-admin ⓘ tooltip bubble. The
   * disabled control's `aria-describedby` and the tooltip's `[tooltipId]`
   * both use it (template refs can't cross `@if` block boundaries).
   */
  protected lastAdminTipId(user: BuilderTeamUser, kind: 'role' | 'deactivate'): string {
    return `last-admin-${kind}-${user.id}`;
  }

  /**
   * The Apply button is enabled only when the staged role differs from
   * the stored role and no save is in flight.
   */
  protected canApplyRole(user: BuilderTeamUser): boolean {
    return (
      this.pendingRoleFor(user) !== user.role &&
      this.updatingUserId() === null &&
      !this.isSoleAdmin(user)
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

  /**
   * Row action buttons are disabled while a row action is in flight — a
   * second tap can never queue a second revoke/deactivate. (The modal
   * ConfirmDialog blocks the page while it is open.)
   */
  protected rowActionsDisabled(): boolean {
    return this.updatingUserId() !== null;
  }

  /**
   * Builder-side view-as eligibility (2026-09-30, Karan): only active
   * members, never other administrators, never yourself. The backend
   * re-checks everything (org scope + #394 admin-target lockdown) — this
   * just keeps the button off rows it could never apply to.
   */
  protected canViewAs(user: BuilderTeamUser): boolean {
    if (user.status !== 'active' || user.role !== 'builder_member') {
      return false;
    }
    return !this.isSelf(user);
  }

  /**
   * Starts view-as for a team member. On success the shell's /me probe
   * flips the portal to the member's view with the banner; on failure the
   * row shows inline error copy.
   */
  protected viewAs(user: BuilderTeamUser): void {
    this.viewAsStartingUserId.set(user.id);
    this.viewAsLastTargetUserId.set(user.id);
    this.store
      .dispatch(new ActivateBuilderViewAs(user.id))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.viewAsStartingUserId.set(null);
      });
  }

  /** Buyer-grade copy for the last view-as failure. */
  protected viewAsErrorMessage(): string | null {
    const error = this.viewAsError();
    if (!error) return null;
    return error === 'forbidden'
      ? this.copy.teamViewAsForbidden
      : this.copy.teamViewAsError;
  }

  /**
   * View-as failures surface inline on the row they targeted, never as a
   * generic banner.
   */
  protected showViewAsError(user: BuilderTeamUser): boolean {
    return (
      this.viewAsError() !== null &&
      this.viewAsStartingUserId() === null &&
      this.viewAsLastTargetUserId() === user.id
    );
  }
}
