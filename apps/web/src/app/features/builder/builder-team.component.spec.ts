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
 * - Deactivate asks for confirmation first; confirming dispatches
 *   `SetBuilderTeamUserStatus`.
 * - Reactivate dispatches directly.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Store } from '@ngxs/store';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderTeamComponent } from './builder-team.component';
import { BuilderTeamState } from './builder-team.state';
import { BuilderState } from './builder.state';
import {
  InviteBuilderTeamUser,
  LoadBuilderTeam,
  SetBuilderTeamUserRole,
  SetBuilderTeamUserStatus,
} from './builder-team.state';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import type { BuilderTeamUser } from './builder-auth.contracts';

const USERS: BuilderTeamUser[] = [
  { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
  { id: 'u2', name: 'Bob', email: 'bob@example.com', role: 'builder_member', status: 'invited', createdAt: '2026-09-28T00:00:00.000Z' },
];

const BUILDER_COPY = {
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
  teamRemoveLabel: 'Remove',
  teamDeactivateConfirm: 'Deactivate this person?',
  teamRemoveConfirm: 'Remove this invite?',
  teamConfirmYes: 'Yes, continue',
  teamConfirmNo: 'Cancel',
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
} = {}) {
  const isAdmin = opts.isAdmin ?? true;
  TestBed.resetTestingModule();
  const seo = { setPage: vi.fn() };
  const dispatched: unknown[] = [];
  const store = {
    dispatch: vi.fn((action: unknown) => {
      dispatched.push(action);
      return of(null);
    }),
    selectSignal: vi.fn((selector: unknown) => {
      if (selector === BuilderTeamState.users) return () => USERS;
      if (selector === BuilderTeamState.status) return () => (opts.status ?? 'ready');
      if (selector === BuilderTeamState.inviteFeedback)
        return () => (opts.feedback ?? null);
      if (selector === BuilderTeamState.actionError) return () => false;
      if (selector === BuilderTeamState.updatingUserId) return () => null;
      if (selector === BuilderState.activeBuilderName) return () => 'Acme Builders';
      if (selector === BuilderState.isBuilderAdmin) return () => isAdmin;
      return () => undefined;
    }),
    selectSnapshot: vi.fn((selector: unknown) => {
      if (selector === BuilderState.isBuilderAdmin) return isAdmin;
      if (selector === BuilderTeamState.inviteFeedback)
        return opts.feedback ?? null;
      return null;
    }),
  };
  const config = {
    get: (section: string) =>
      section === 'copy' ? { builder: BUILDER_COPY } : {},
  };

  TestBed.configureTestingModule({
    imports: [BuilderTeamComponent],
    providers: [
      { provide: Store, useValue: store },
      { provide: ConfigService, useValue: config },
      { provide: SeoService, useValue: seo },
    ],
  });
  const fixture: ComponentFixture<BuilderTeamComponent> =
    TestBed.createComponent(BuilderTeamComponent);
  fixture.detectChanges();
  return { fixture, dispatched };
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

  it('a failed invite shows the error banner', () => {
    const { fixture } = setup({ feedback: 'failed' });
    const banner = fixture.nativeElement.querySelector(
      '.builder-team__banner--error',
    ) as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Could not send the invite.');
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

  it('deactivate asks for confirmation before dispatching', () => {
    const { fixture, dispatched } = setup();
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ) as HTMLButtonElement[];
    const deactivate = buttons.find((b) => b.textContent?.includes('Deactivate'));
    deactivate?.click();
    fixture.detectChanges();
    // Confirm dialog appears; nothing dispatched yet.
    expect(
      dispatched.some((a) => a instanceof SetBuilderTeamUserStatus),
    ).toBe(false);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Deactivate this person?');
    // Confirming dispatches the status change.
    const confirm = (
      fixture.nativeElement.querySelectorAll('.builder-team__confirm-actions button') as NodeListOf<HTMLButtonElement>
    )[1];
    confirm.click();
    const action = dispatched.find(
      (a) => a instanceof SetBuilderTeamUserStatus,
    ) as SetBuilderTeamUserStatus;
    expect(action).toBeDefined();
    expect(action.status).toBe('deactivated');
  });
});
