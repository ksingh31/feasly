/**
 * Builder team component specs (auth/05).
 *
 * - Renders the user list with role/status labels from config copy.
 * - Admin design: header + invite button, banner, skeleton rows, table,
 *   empty state, error + retry.
 * - The invite form (modal) renders only for builder_admins; a non-admin
 *   sees a read-only table plus a notice.
 * - The invite form validates name + email and dispatches
 *   `InviteBuilderTeamUser` on submit; success shows the sent banner and
 *   closes the modal, failure shows the error banner.
 * - Deactivate and Revoke confirm in the shared ConfirmDialog (danger)
 *   first; confirming dispatches, cancelling does nothing (#535).
 * - Pending invites offer only Resend + Revoke; Resend dispatches directly.
 * - Success toasts; failures stay inline on the row.
 * - The signed-in user's row carries a "You" tag and no manage controls;
 *   deactivated rows are greyed with no role select.
 * - Reactivate dispatches directly.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Store } from '@ngxs/store';
import { of, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderTeamComponent } from './builder-team.component';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { ActivateBuilderViewAs } from './builder.actions';
import { InfoTooltipComponent } from '../../shared/components/info-tooltip';
import { BuilderTeamState } from './builder-team.state';
import { BuilderState } from './builder.state';
import {
  InviteBuilderTeamUser,
  LoadBuilderTeam,
  RemoveBuilderTeamUser,
  ResendBuilderTeamInvite,
  SetBuilderTeamUserRole,
  SetBuilderTeamUserStatus,
} from './builder-team.state';
import { UiConfirmService, UiToastService } from '@app/shared/ui';
import type { UiConfirmOptions, UiToastOptions } from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import type { BuilderTeamUser } from './builder-auth.contracts';

const USERS: BuilderTeamUser[] = [
  { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
  { id: 'u2', name: 'Bob', email: 'bob@example.com', role: 'builder_member', status: 'invited', createdAt: '2026-09-28T00:00:00.000Z' },
];

const TEAM_COPY = {
  teamHeading: 'Team',
  teamIntro: 'Manage your team.',
  teamLoading: 'Loading your team…',
  teamLoadError: 'Could not load your team.',
  teamRetry: 'Retry',
  teamEmpty: 'No team members yet.',
  teamColName: 'Name',
  teamColEmail: 'Email',
  teamColRole: 'Role',
  teamApplyRole: 'Apply',
  teamColStatus: 'Status',
  teamColAdded: 'Added',
  teamColActions: 'Actions',
  teamStatusActive: 'Active',
  teamStatusInvited: 'Invited',
  teamStatusDeactivated: 'Deactivated',
  teamInviteHeading: 'Invite a teammate',
  teamInviteButton: 'Invite team member',
  teamInviteModalSub: 'They get an email invite.',
  teamInviteNameLabel: 'Full name',
  teamInviteNameInvalid: 'Enter their name.',
  teamInviteEmailLabel: 'Work email',
  teamInviteRoleLabel: 'Role',
  teamInviteSubmit: 'Send invite',
  teamInviteSent: 'Invite sent.',
  teamInviteError: 'Could not send the invite.',
  teamDeactivateLabel: 'Deactivate',
  teamReactivateLabel: 'Reactivate',
  teamConfirmNo: 'Cancel',
  teamYouTag: 'You',
  teamResendLabel: 'Resend',
  teamResent: 'Invite resent to {email}.',
  teamRevokeLabel: 'Revoke',
  teamRevokeTitle: 'Revoke the invite for {name}?',
  teamRevokeBody: 'Their invite link stops working.',
  teamRevoked: 'Invite for {name} revoked.',
  teamDeactivateTitle: 'Deactivate {name}?',
  teamDeactivateBody: 'They lose access immediately.',
  teamDeactivated: '{name} deactivated.',
  teamReactivated: '{name} reactivated.',
  teamViewAsHint: 'See the portal as {name} sees it.',
  teamActionError: 'Something went wrong.',
  teamCountOne: '1 team member',
  teamCountMany: 'team members',
  teamNotAdmin: 'Only organization administrators can manage the team.',
  orgRoleAdmin: 'Administrator',
  orgRoleMember: 'Member',
  emailInvalid: 'Enter a valid email address.',
};

type TeamStatus = 'loading' | 'error' | 'ready';
type InviteFeedback = 'sent' | 'failed' | null;

function setup(opts: {
  isAdmin?: boolean;
  status?: TeamStatus;
  feedback?: InviteFeedback;
  inviting?: boolean;
  inviteError?: string | null;
  copyExtra?: Record<string, string>;
  users?: BuilderTeamUser[];
  actionError?: boolean;
  actionErrorUserId?: string | null;
  actionErrorMessage?: string | null;
  canInitiateViewAs?: boolean;
  viewAsBusy?: boolean;
  viewAsError?: 'forbidden' | 'failed' | null;
  sessionEmail?: string;
  /**
   * When true, the mock dispatch of `ActivateBuilderViewAs` returns a
   * pending Subject (exposed via the returned `viewAsPending` array) so
   * the test can hold the per-row busy state, then complete it to land
   * the error. Avoids timing races: Subject completion is synchronous.
   */
  deferredViewAs?: boolean;
  /** ConfirmDialog answer (#535); default true (verb pressed). */
  confirmAnswer?: boolean;
} = {}) {
  const isAdmin = opts.isAdmin ?? true;
  TestBed.resetTestingModule();
  const seo = { setPage: vi.fn() };
  const dispatched: unknown[] = [];
  const viewAsPending: Subject<unknown>[] = [];
  const confirmCalls: UiConfirmOptions[] = [];
  const toastCalls: UiToastOptions[] = [];
  const confirms = {
    confirm: vi.fn((options: UiConfirmOptions) => {
      confirmCalls.push(options);
      return of(opts.confirmAnswer ?? true);
    }),
  };
  const toasts = {
    show: vi.fn((options: UiToastOptions) => {
      toastCalls.push(options);
      return { id: toastCalls.length, dismissed: of('manual'), dismiss: () => undefined };
    }),
  };
  const store = {
    dispatch: vi.fn((action: unknown) => {
      dispatched.push(action);
      if (opts.deferredViewAs && action instanceof ActivateBuilderViewAs) {
        const pending = new Subject<unknown>();
        viewAsPending.push(pending);
        return pending.asObservable();
      }
      return of(null);
    }),
    selectSignal: vi.fn((selector: unknown) => {
      if (selector === BuilderTeamState.users) return () => opts.users ?? USERS;
      if (selector === BuilderTeamState.status) return () => (opts.status ?? 'ready');
      if (selector === BuilderTeamState.inviteFeedback)
        return () => (opts.feedback ?? null);
      if (selector === BuilderTeamState.inviting)
        return () => (opts.inviting ?? false);
      if (selector === BuilderTeamState.inviteError)
        return () => (opts.inviteError ?? null);
      if (selector === BuilderTeamState.actionError) return () => (opts.actionError ?? false);
      if (selector === BuilderTeamState.actionErrorUserId)
        return () => (opts.actionErrorUserId ?? null);
      if (selector === BuilderTeamState.actionErrorMessage)
        return () => (opts.actionErrorMessage ?? null);
      if (selector === BuilderTeamState.updatingUserId) return () => null;
      if (selector === BuilderState.activeBuilderName) return () => 'Acme Builders';
      if (selector === BuilderState.isBuilderAdmin) return () => isAdmin;
      // Builder-side view-as (2026-09-30, Karan).
      if (selector === BuilderState.canInitiateViewAs)
        return () => opts.canInitiateViewAs ?? isAdmin;
      if (selector === BuilderState.viewAsBusy)
        return () => opts.viewAsBusy ?? false;
      if (selector === BuilderState.viewAsError)
        return () => opts.viewAsError ?? null;
      if (selector === BuilderState.session)
        return () => ({ email: opts.sessionEmail ?? 'admin@example.com' });
      return () => undefined;
    }),
    selectSnapshot: vi.fn((selector: unknown) => {
      if (selector === BuilderState.isBuilderAdmin) return isAdmin;
      if (selector === BuilderTeamState.inviteFeedback)
        return opts.feedback ?? null;
      if (selector === BuilderTeamState.actionError) return opts.actionError ?? false;
      if (selector === BuilderTeamState.actionErrorUserId)
        return opts.actionErrorUserId ?? null;
      return null;
    }),
  };
  const config = {
    get: (section: string) =>
      section === 'copy' ? { builder: TEAM_COPY } : {},
  };

  TestBed.configureTestingModule({
    imports: [BuilderTeamComponent],
    providers: [
      { provide: BUILDER_COPY, useValue: { ...DEFAULT_BUILDER_COPY, ...TEAM_COPY, ...(opts.copyExtra ?? {}) } },
      { provide: Store, useValue: store },
      { provide: ConfigService, useValue: config },
      { provide: SeoService, useValue: seo },
      { provide: UiConfirmService, useValue: confirms },
      { provide: UiToastService, useValue: toasts },
    ],
  });
  const fixture: ComponentFixture<BuilderTeamComponent> =
    TestBed.createComponent(BuilderTeamComponent);
  fixture.detectChanges();
  return { fixture, dispatched, viewAsPending, confirmCalls, toastCalls };
}

function openInviteModal(fixture: ComponentFixture<BuilderTeamComponent>) {
  const buttons = Array.from(
    fixture.nativeElement.querySelectorAll('button'),
  ) as HTMLButtonElement[];
  const inviteButton = buttons.find((b) =>
    b.textContent?.includes('Invite team member'),
  );
  expect(inviteButton).toBeDefined();
  inviteButton!.click();
  fixture.detectChanges();
}

describe('BuilderTeamComponent (auth/05)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('loads the team on init and renders each user', () => {
    const { fixture, dispatched } = setup();
    expect(dispatched.some((a) => a instanceof LoadBuilderTeam)).toBe(true);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('alice@example.com');
    expect(text).toContain('bob@example.com');
    expect(text).toContain('Active');
    expect(text).toContain('Invited');
    expect(text).toContain('2 team members');
  });

  it('an admin sees the invite button, role selects, and actions', () => {
    const { fixture } = setup({ isAdmin: true });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Invite team member');
    expect(
      fixture.nativeElement.querySelectorAll('.builder-team__role-select').length,
    ).toBe(2);
    expect(fixture.nativeElement.querySelectorAll('.builder-team__actions').length).toBe(2);
    expect(text).not.toContain('Only organization administrators');
  });

  it('changing a role only stages it; Apply dispatches exactly one update', () => {
    const { fixture, dispatched } = setup({ isAdmin: true });
    const selects = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-team__role-select'),
    ) as HTMLSelectElement[];
    // Bob (u2) is builder_member.
    const bobSelect = selects[1] as HTMLSelectElement;
    expect(bobSelect.value).toBe('builder_member');

    bobSelect.value = 'builder_admin';
    bobSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    // No dispatch on selection: only the staged LoadBuilderTeam happened.
    expect(dispatched.some((a) => a instanceof SetBuilderTeamUserRole)).toBe(false);

    const applyButtons = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-team__apply'),
    ) as HTMLButtonElement[];
    expect(applyButtons).toHaveLength(2);
    const aliceApply = applyButtons[0] as HTMLButtonElement;
    const bobApply = applyButtons[1] as HTMLButtonElement;
    // Only Bob's Apply is enabled — Alice's staged role matches her stored role.
    expect(aliceApply.disabled).toBe(true);
    expect(bobApply.disabled).toBe(false);

    bobApply.click();
    fixture.detectChanges();
    const roleActions = dispatched.filter(
      (a) => a instanceof SetBuilderTeamUserRole,
    ) as SetBuilderTeamUserRole[];
    expect(roleActions).toHaveLength(1);
    expect(roleActions[0].id).toBe('u2');
    expect(roleActions[0].role).toBe('builder_admin');
  });
  it('a non-admin sees a read-only table with a notice, no invite form', () => {    const { fixture } = setup({ isAdmin: false });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Only organization administrators can manage the team.');
    expect(text).not.toContain('Invite team member');
    expect(
      fixture.nativeElement.querySelectorAll('.builder-team__role-select').length,
    ).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('.builder-team__actions').length).toBe(0);
    expect(
      fixture.nativeElement.querySelector('.builder-team__overlay'),
    ).toBeNull();
    // Users are still visible (read-only).
    expect(text).toContain('alice@example.com');
  });

  it('opening the invite button renders the invite modal', () => {
    const { fixture } = setup();
    openInviteModal(fixture);
    const modal = fixture.nativeElement.querySelector('.builder-team__modal');
    expect(modal).not.toBeNull();
    expect(modal.textContent).toContain('Invite a teammate');
    expect(modal.textContent).toContain('Send invite');
  });

  it('submitting a valid invite dispatches InviteBuilderTeamUser', () => {
    const { fixture, dispatched } = setup();
    openInviteModal(fixture);
    const component = fixture.componentInstance;
    component.inviteForm.setValue({
      name: 'Cara',
      email: 'cara@example.com',
      role: 'builder_member',
    });
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('ngSubmit'));
    const invite = dispatched.find(
      (a) => a instanceof InviteBuilderTeamUser,
    ) as InviteBuilderTeamUser;
    expect(invite).toBeDefined();
    expect(invite.name).toBe('Cara');
    expect(invite.email).toBe('cara@example.com');
    expect(invite.role).toBe('builder_member');
  });

  it('an invalid email blocks the invite dispatch', () => {
    const { fixture, dispatched } = setup();
    openInviteModal(fixture);
    const component = fixture.componentInstance;
    component.inviteForm.setValue({
      name: 'Cara',
      email: 'not-an-email',
      role: 'builder_member',
    });
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('ngSubmit'));
    expect(
      dispatched.some((a) => a instanceof InviteBuilderTeamUser),
    ).toBe(false);
  });

  it('an empty name blocks the invite dispatch', () => {
    const { fixture, dispatched } = setup();
    openInviteModal(fixture);
    const component = fixture.componentInstance;
    component.inviteForm.setValue({
      name: '',
      email: 'cara@example.com',
      role: 'builder_member',
    });
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('ngSubmit'));
    expect(
      dispatched.some((a) => a instanceof InviteBuilderTeamUser),
    ).toBe(false);
  });

  it('a sent invite shows the confirmation banner', () => {
    const { fixture } = setup({ feedback: 'sent' });
    const banner = fixture.nativeElement.querySelector(
      '.builder-team__banner[role="status"]',
    ) as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Invite sent.');
  });

  it('a failed invite shows the API message inline in the dialog', () => {
    const { fixture } = setup({
      inviteError: 'An invite is already on its way.',
    });
    openInviteModal(fixture);
    const alert = fixture.nativeElement.querySelector(
      '.builder-team__modal [role="alert"]',
    ) as HTMLElement;
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain('An invite is already on its way.');
    // No generic error banner anymore.
    expect(
      fixture.nativeElement.querySelector('.builder-team__banner--error'),
    ).toBeNull();
  });

  it('blocks invite re-entry while an invite is in flight', () => {
    const { fixture, dispatched } = setup({ inviting: true });
    openInviteModal(fixture);
    const component = fixture.componentInstance;
    component.inviteForm.setValue({
      name: 'Cara',
      email: 'cara@example.com',
      role: 'builder_member',
    });
    fixture.detectChanges();
    const submit = fixture.nativeElement.querySelector(
      '.builder-team__modal-actions button[type="submit"]',
    ) as HTMLButtonElement;
    // Busy state: disabled button with the sending label.
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain('Sending…');
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('ngSubmit'));
    expect(
      dispatched.some((a) => a instanceof InviteBuilderTeamUser),
    ).toBe(false);
  });

  it('an already-teamed email shows the inline duplicate error, no API call', () => {
    const { fixture, dispatched } = setup();
    openInviteModal(fixture);
    const component = fixture.componentInstance;
    component.inviteForm.setValue({
      name: 'Alice Clone',
      email: 'ALICE@example.com',
      role: 'builder_member',
    });
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('ngSubmit'));
    fixture.detectChanges();
    expect(
      dispatched.some((a) => a instanceof InviteBuilderTeamUser),
    ).toBe(false);
    const alert = fixture.nativeElement.querySelector(
      '.builder-team__modal [role="alert"]',
    ) as HTMLElement;
    expect(alert.textContent).toContain('This email is already on the team.');
  });

  it('a pending-invite email shows the on-its-way message, no API call', () => {
    const { fixture, dispatched } = setup();
    openInviteModal(fixture);
    const component = fixture.componentInstance;
    component.inviteForm.setValue({
      name: 'Bob Again',
      email: 'bob@example.com',
      role: 'builder_member',
    });
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('ngSubmit'));
    fixture.detectChanges();
    expect(
      dispatched.some((a) => a instanceof InviteBuilderTeamUser),
    ).toBe(false);
    const alert = fixture.nativeElement.querySelector(
      '.builder-team__modal [role="alert"]',
    ) as HTMLElement;
    expect(alert.textContent).toContain(
      'An invite is already on its way to this email address.',
    );
  });

  it('loading shows skeleton rows, error shows retry', () => {
    const loading = setup({ status: 'loading' });
    expect(
      loading.fixture.nativeElement.querySelectorAll('.builder-team__skeleton').length,
    ).toBe(4);

    const errored = setup({ status: 'error' });
    const text = errored.fixture.nativeElement.textContent as string;
    expect(text).toContain('Could not load your team.');
    expect(text).toContain('Retry');
  });

  it('deactivate confirms in the ConfirmDialog (danger) before dispatching', () => {
    // auth/07: the confirm flow needs an enabled Deactivate, so seed two
    // active admins (with a sole admin the button is disabled instead).
    const { fixture, dispatched, confirmCalls, toastCalls } = setup({
      users: [
        { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
        { id: 'u2', name: 'Bob', email: 'bob@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
      ],
    });
    const bobDeactivate = rowOf(fixture, 'Bob').querySelector(
      'button.builder-team__danger-link',
    ) as HTMLButtonElement;
    expect(bobDeactivate.textContent).toContain('Deactivate');
    bobDeactivate.click();
    expect(confirmCalls).toEqual([
      {
        title: 'Deactivate Bob?',
        body: 'They lose access immediately.',
        verb: 'Deactivate',
        tone: 'danger',
        cancelLabel: 'Cancel',
      },
    ]);
    const action = dispatched.find(
      (a) => a instanceof SetBuilderTeamUserStatus,
    ) as SetBuilderTeamUserStatus;
    expect(action).toBeDefined();
    expect(action.id).toBe('u2');
    expect(action.status).toBe('deactivated');
    expect(toastCalls.map((t) => t.message)).toEqual(['Bob deactivated.']);
  });

  it('cancelling the ConfirmDialog dispatches nothing and shows no toast', () => {
    const { fixture, dispatched, toastCalls } = setup({ confirmAnswer: false });
    (rowOf(fixture, 'Bob').querySelector('button.builder-team__danger-link') as HTMLButtonElement).click();
    expect(dispatched.some((a) => a instanceof RemoveBuilderTeamUser)).toBe(false);
    expect(toastCalls).toEqual([]);
  });

  it('a pending invite offers only Resend and Revoke (no Deactivate / Remove)', () => {
    const { fixture } = setup();
    const labels = actionLabels(rowOf(fixture, 'Bob'));
    expect(labels).toEqual(['Resend', 'Revoke']);
  });

  it('revoke is id-scoped, confirms naming the invitee, then toasts', () => {
    const { fixture, dispatched, confirmCalls, toastCalls } = setup();
    const revoke = rowOf(fixture, 'Bob').querySelector(
      'button.builder-team__danger-link',
    ) as HTMLButtonElement;
    expect(revoke.textContent).toContain('Revoke');
    revoke.click();
    expect(confirmCalls[0]).toMatchObject({
      title: 'Revoke the invite for Bob?',
      verb: 'Revoke',
      tone: 'danger',
    });
    const action = dispatched.find(
      (a) => a instanceof RemoveBuilderTeamUser,
    ) as RemoveBuilderTeamUser;
    expect(action.id).toBe('u2');
    expect(toastCalls.map((t) => t.message)).toEqual(['Invite for Bob revoked.']);
  });

  it('resend dispatches directly (no confirm) and toasts the email', () => {
    const { fixture, dispatched, confirmCalls, toastCalls } = setup();
    const resend = Array.from(
      rowOf(fixture, 'Bob').querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('Resend')) as HTMLButtonElement;
    resend.click();
    expect(confirmCalls).toEqual([]);
    const action = dispatched.find(
      (a) => a instanceof ResendBuilderTeamInvite,
    ) as ResendBuilderTeamInvite;
    expect(action.id).toBe('u2');
    expect(toastCalls.map((t) => t.message)).toEqual(['Invite resent to bob@example.com.']);
  });

  it('a failed resend shows no toast — the error stays inline on the row', () => {
    const { fixture, toastCalls } = setup({
      actionError: true,
      actionErrorUserId: 'u2',
      actionErrorMessage: 'Only pending invites can be resent.',
    });
    const row = rowOf(fixture, 'Bob');
    (Array.from(row.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Resend'),
    ) as HTMLButtonElement).click();
    expect(toastCalls).toEqual([]);
    expect(row.querySelector('[role="alert"]')?.textContent).toContain(
      'Only pending invites can be resent.',
    );
  });

  it('tags the signed-in user "You" and gives their row no manage controls', () => {
    const { fixture } = setup({
      sessionEmail: 'Alice@Example.com',
      users: [
        { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
        { id: 'u3', name: 'Cara', email: 'cara@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
      ],
    });
    const self = rowOf(fixture, 'Alice');
    expect(self.querySelector('.builder-team__you')?.textContent?.trim()).toBe('You');
    expect(self.querySelector('select')).toBeNull();
    expect(actionLabels(self)).toEqual([]);
    const other = rowOf(fixture, 'Cara');
    expect(other.querySelector('.builder-team__you')).toBeNull();
    expect(other.querySelector('select')).not.toBeNull();
  });

  it('greys a deactivated row, shows its role as text, and offers Reactivate', () => {
    const { fixture, dispatched, toastCalls } = setup({
      users: [
        { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
        { id: 'u4', name: 'Dan', email: 'dan@example.com', role: 'builder_member', status: 'deactivated', createdAt: '2026-09-28T00:00:00.000Z' },
      ],
    });
    const row = rowOf(fixture, 'Dan');
    expect(row.classList).toContain('builder-team__row--deactivated');
    expect(row.querySelector('select')).toBeNull();
    expect(row.textContent).toContain('Member');
    expect(row.textContent).toContain('Deactivated');
    expect(actionLabels(row)).toEqual(['Reactivate']);
    (row.querySelector('.builder-team__actions button') as HTMLButtonElement).click();
    const action = dispatched.find(
      (a) => a instanceof SetBuilderTeamUserStatus,
    ) as SetBuilderTeamUserStatus;
    expect(action).toMatchObject({ id: 'u4', status: 'active' });
    expect(toastCalls.map((t) => t.message)).toEqual(['Dan reactivated.']);
  });

  it('explains "View as" with a tooltip naming the member', () => {
    const { fixture } = setup({
      users: [
        { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
        { id: 'u5', name: 'Marco', email: 'marco@example.com', role: 'builder_member', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
      ],
    });
    const tooltip = fixture.debugElement
      .queryAll(By.directive(InfoTooltipComponent))
      .find((d) => d.componentInstance.tooltipId() === 'view-as-hint-u5');
    expect(tooltip).toBeDefined();
    expect(tooltip!.componentInstance.text()).toBe('See the portal as Marco sees it.');
    const viewAs = Array.from(
      rowOf(fixture, 'Marco').querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('View as')) as HTMLButtonElement;
    expect(viewAs.getAttribute('aria-describedby')).toBe('view-as-hint-u5');
  });
});

/** The table row whose name cell reads `name`. */
function rowOf(fixture: ComponentFixture<BuilderTeamComponent>, name: string): HTMLTableRowElement {
  const rows = Array.from(
    fixture.nativeElement.querySelectorAll('tbody tr'),
  ) as HTMLTableRowElement[];
  const row = rows.find(
    (r) => r.querySelector('.builder-team__name')?.textContent?.trim() === name,
  );
  expect(row, `row for ${name}`).toBeDefined();
  return row!;
}

/** Visible action-button labels in a row (ⓘ tooltip triggers excluded). */
function actionLabels(row: HTMLElement): string[] {
  return (
    Array.from(
      row.querySelectorAll('.builder-team__actions button:not(.info-tooltip__trigger)'),
    ) as HTMLButtonElement[]
  ).map((b) => b.textContent?.trim() ?? '');
}

/**
 * Builder team component specs (auth/07 — last-admin protection).
 *
 * - The sole remaining active admin's role select + Apply are disabled with
 *   an ⓘ tooltip carrying the exact story explainer; Deactivate is disabled
 *   with its own ⓘ tooltip explainer (no inline notes under the controls).
 * - With two active admins (or when pending/deactivated admins are the
 *   only others), the controls stay enabled / the guard still trips.
 */
describe('BuilderTeamComponent (auth/07 — last-admin protection)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  const ROLE_NOTE =
    "You can't change the role of the last administrator. Add another administrator first.";
  const DEACTIVATE_NOTE =
    'Every organization needs at least one active administrator.';

  /** The auth/07 ⓘ tooltips rendered inside a scope (row or table). */
  function tooltipsIn(
    fixture: ComponentFixture<BuilderTeamComponent>,
    scope: HTMLElement,
  ): InfoTooltipComponent[] {
    return fixture.debugElement
      .queryAll(By.directive(InfoTooltipComponent))
      .filter((d) => scope.contains(d.nativeElement as Node))
      .map((d) => d.componentInstance as InfoTooltipComponent);
  }

  function tooltipTexts(
    fixture: ComponentFixture<BuilderTeamComponent>,
    scope: HTMLElement,
  ): string[] {
    return tooltipsIn(fixture, scope).map((t) => t.text());
  }

  function soleAdminUsers(): BuilderTeamUser[] {
    return [
      { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
      { id: 'u2', name: 'Bob', email: 'bob@example.com', role: 'builder_member', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
    ];
  }

  function rowFor(fixture: ComponentFixture<BuilderTeamComponent>, index: number): HTMLElement {
    return fixture.nativeElement.querySelectorAll('tbody tr')[index] as HTMLElement;
  }

  function roleSelectFor(fixture: ComponentFixture<BuilderTeamComponent>, index: number): HTMLSelectElement {
    return fixture.nativeElement.querySelectorAll('.builder-team__role-select')[index] as HTMLSelectElement;
  }

  it('sole admin: role select and Apply are disabled with the ⓘ tooltip explainer', () => {
    const { fixture } = setup({ isAdmin: true, users: soleAdminUsers() });
    // Alice (u1) is the only active builder_admin.
    const select = roleSelectFor(fixture, 0);
    expect(select.disabled).toBe(true);
    const row = rowFor(fixture, 0);
    expect(tooltipTexts(fixture, row)).toContain(ROLE_NOTE);
    // The trigger icon renders beside the disabled select, and the select
    // points at the tooltip for screen readers.
    expect(row.querySelector('app-info-tooltip .info-tooltip__trigger')).not.toBeNull();
    const tip = tooltipsIn(fixture, row).find((t) => t.text() === ROLE_NOTE)!;
    expect(tip.tooltipId()).toBe('last-admin-role-u1');
    expect(select.getAttribute('aria-describedby')).toBe('last-admin-role-u1');
    // No inline explainer text under the controls anymore.
    expect(row.querySelector('.builder-team__note:not(.builder-team__note--error)')).toBeNull();
    // Bob (u2) is a member — his select stays enabled.
    expect(roleSelectFor(fixture, 1).disabled).toBe(false);
  });

  it('sole admin: Deactivate is disabled with the ⓘ tooltip explainer', async () => {
    const { fixture } = setup({ isAdmin: true, users: soleAdminUsers() });
    const row = rowFor(fixture, 0);
    const deactivate = Array.from(row.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Deactivate'),
    ) as HTMLButtonElement;
    expect(deactivate).toBeDefined();
    expect(deactivate.disabled).toBe(true);
    expect(tooltipTexts(fixture, row)).toContain(DEACTIVATE_NOTE);
    // Scope to the deactivate tooltip's own element — the row also
    // carries the role tooltip.
    const tipDebug = fixture.debugElement
      .queryAll(By.directive(InfoTooltipComponent))
      .find(
        (d) =>
          row.contains(d.nativeElement as Node) &&
          (d.componentInstance as InfoTooltipComponent).text() ===
            DEACTIVATE_NOTE,
      )!;
    const tip = tipDebug.componentInstance as InfoTooltipComponent;
    expect(tip.tooltipId()).toBe('last-admin-deactivate-u1');
    expect(deactivate.getAttribute('aria-describedby')).toBe('last-admin-deactivate-u1');

    // The explainer shows on demand: tap the ⓘ icon.
    const trigger = tipDebug.nativeElement.querySelector(
      '.info-tooltip__trigger',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    const bubble = tipDebug.nativeElement.querySelector(
      '.info-tooltip__bubble',
    ) as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble.getAttribute('role')).toBe('tooltip');
    expect(bubble.textContent?.trim()).toBe(DEACTIVATE_NOTE);
  });

  it('two active admins: controls stay enabled and no tooltip shows', () => {
    const { fixture } = setup({
      isAdmin: true,
      users: [
        { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
        { id: 'u2', name: 'Bob', email: 'bob@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
      ],
    });
    expect(roleSelectFor(fixture, 0).disabled).toBe(false);
    const row = rowFor(fixture, 0);
    const deactivate = Array.from(row.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Deactivate'),
    ) as HTMLButtonElement;
    expect(deactivate.disabled).toBe(false);
    expect(
      fixture.nativeElement.querySelector('app-info-tooltip'),
    ).toBeNull();
  });

  it('deactivated and invited admins never count toward the guard', () => {
    const { fixture } = setup({
      isAdmin: true,
      users: [
        { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
        { id: 'u2', name: 'Carol', email: 'carol@example.com', role: 'builder_admin', status: 'deactivated', createdAt: '2026-09-28T00:00:00.000Z' },
        { id: 'u3', name: 'Dave', email: 'dave@example.com', role: 'builder_admin', status: 'invited', createdAt: '2026-09-28T00:00:00.000Z' },
      ],
    });
    // Alice is still the only ACTIVE admin — her controls are locked.
    expect(roleSelectFor(fixture, 0).disabled).toBe(true);
    const texts = tooltipTexts(fixture, rowFor(fixture, 0));
    expect(texts).toContain(ROLE_NOTE);
    expect(texts).toContain(DEACTIVATE_NOTE);
  });

  it('a backend 409 race surfaces inline on the targeted row, not as a banner', () => {
    // Two admins so the controls are enabled; the backend still refuses
    // with 409 (the race the disabled UI can't prevent).
    const { fixture } = setup({
      isAdmin: true,
      users: [
        { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
        { id: 'u2', name: 'Bob', email: 'bob@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
      ],
      actionError: true,
      actionErrorUserId: 'u1',
      actionErrorMessage: DEACTIVATE_NOTE,
    });
    const row = rowFor(fixture, 0);
    const note = row.querySelector(
      '.builder-team__note--error',
    ) as HTMLElement;
    expect(note?.textContent?.trim()).toBe(DEACTIVATE_NOTE);
    // Row-tagged failures never use the generic banner.
    expect(
      fixture.nativeElement.querySelector('.builder-team__state--error'),
    ).toBeNull();
    // The other row shows no error.
    expect(
      rowFor(fixture, 1).querySelector('.builder-team__note--error'),
    ).toBeNull();
  });
});

describe('BuilderTeamComponent (builder-side view-as, 2026-09-30)', () => {
  const VIEW_AS_USERS: BuilderTeamUser[] = [
    { id: 'u1', name: 'Alice Admin', email: 'alice@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
    { id: 'u2', name: 'Bob Member', email: 'bob@example.com', role: 'builder_member', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
    { id: 'u3', name: 'Cara Invited', email: 'cara@example.com', role: 'builder_member', status: 'invited', createdAt: '2026-09-28T00:00:00.000Z' },
    { id: 'u4', name: 'Dan Off', email: 'dan@example.com', role: 'builder_member', status: 'deactivated', createdAt: '2026-09-28T00:00:00.000Z' },
    { id: 'u5', name: 'Self Admin', email: 'admin@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
  ];

  function rowFor(fixture: ComponentFixture<BuilderTeamComponent>, index: number): HTMLElement {
    return fixture.nativeElement.querySelectorAll('tbody tr')[index];
  }

  function viewAsButtons(fixture: ComponentFixture<BuilderTeamComponent>): HTMLButtonElement[] {
    return (
      Array.from(
        fixture.nativeElement.querySelectorAll('tbody tr button'),
      ) as HTMLButtonElement[]
    ).filter((b) =>
      /View as|Starting…/.test(b.textContent ?? ''),
    );
  }

  it('shows "View as" only on eligible rows (active members, not admins, not self)', () => {
    const { fixture } = setup({ users: VIEW_AS_USERS });
    // Bob (u2) is the only eligible row: Alice and Self are admins, Cara
    // is invited, Dan is deactivated.
    const buttons = viewAsButtons(fixture);
    expect(buttons).toHaveLength(1);
    expect(rowFor(fixture, 1).contains(buttons[0])).toBe(true);
  });

  it('hides "View as" when the session cannot initiate', () => {
    const { fixture } = setup({ users: VIEW_AS_USERS, canInitiateViewAs: false });
    expect(viewAsButtons(fixture)).toHaveLength(0);
  });

  it('dispatches ActivateBuilderViewAs with the row user id', () => {
    const { fixture, dispatched } = setup({ users: VIEW_AS_USERS });
    const buttons = viewAsButtons(fixture);
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    // ngOnInit also dispatches LoadBuilderTeam — the view-as dispatch is
    // the last one.
    expect(dispatched).toHaveLength(2);
    const action = dispatched[dispatched.length - 1] as ActivateBuilderViewAs;
    expect(action).toBeInstanceOf(ActivateBuilderViewAs);
    expect(action.userId).toBe('u2');
  });

  it('shows the busy copy on the targeted row while starting', () => {
    // viewAsBusy stays false here so the button is clickable; the per-row
    // "Starting…" copy is driven by viewAsStartingUserId, which holds while
    // the (deferred) dispatch is pending.
    const { fixture } = setup({ users: VIEW_AS_USERS, deferredViewAs: true });
    const buttons = viewAsButtons(fixture);
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    fixture.detectChanges();
    const refreshed = viewAsButtons(fixture);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].textContent).toContain('Starting…');
  });

  it('renders the failure note inline on the targeted row', () => {
    const { fixture, viewAsPending } = setup({
      users: VIEW_AS_USERS,
      viewAsError: 'failed',
      deferredViewAs: true,
    });
    viewAsButtons(fixture)[0].click();
    fixture.detectChanges();
    // Complete the mocked dispatch: busy clears, the failure anchors to
    // the row via viewAsLastTargetUserId (never a generic banner).
    viewAsPending[0].next(null);
    viewAsPending[0].complete();
    fixture.detectChanges();
    const note = rowFor(fixture, 1).querySelector('.builder-team__note--error');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('Could not start viewing as this member');
    // Other rows stay clean.
    expect(rowFor(fixture, 0).querySelector('.builder-team__note--error')).toBeNull();
  });
});
