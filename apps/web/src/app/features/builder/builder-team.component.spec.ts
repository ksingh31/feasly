/**
 * Builder team component specs (auth/05).
 *
 * - Renders the user list with role/status labels from config copy.
 * - The invite form validates name + email and dispatches
 *   `InviteBuilderTeamUser` on submit.
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
  SetBuilderTeamUserStatus,
} from './builder-team.state';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import type { BuilderTeamUser } from './builder-auth.contracts';

const USERS: BuilderTeamUser[] = [
  { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'builder_admin', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' },
  { id: 'u2', name: 'Bob', email: 'bob@example.com', role: 'builder_member', status: 'invited', createdAt: '2026-09-28T00:00:00.000Z' },
];

function setup() {
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
      if (selector === BuilderTeamState.status) return () => 'ready' as const;
      if (selector === BuilderTeamState.inviteFeedback) return () => null;
      if (selector === BuilderTeamState.actionError) return () => false;
      if (selector === BuilderTeamState.updatingUserId) return () => null;
      if (selector === BuilderState.activeBuilderName) return () => 'Acme Builders';
      return () => undefined;
    }),
    selectSnapshot: vi.fn(() => null),
  };
  const config = {
    get: (section: string) =>
      section === 'copy'
        ? {
            builder: {
              teamHeading: 'Team',
              teamIntro: 'Manage your team.',
              teamLoading: 'Loading your team…',
              teamLoadError: 'Could not load your team.',
              teamRetry: 'Retry',
              teamEmpty: 'No team members yet.',
              teamColName: 'Name',
              teamColEmail: 'Email',
              teamColRole: 'Role',
              teamColStatus: 'Status',
              teamColActions: 'Actions',
              teamStatusActive: 'Active',
              teamStatusInvited: 'Invited',
              teamStatusDeactivated: 'Deactivated',
              teamInviteHeading: 'Invite a teammate',
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
              orgRoleAdmin: 'Administrator',
              orgRoleMember: 'Member',
              emailInvalid: 'Enter a valid email address.',
            },
          }
        : {},
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
  });

  it('submitting a valid invite dispatches InviteBuilderTeamUser', () => {
    const { fixture, dispatched } = setup();
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
      fixture.nativeElement.querySelectorAll('.builder-team__confirm button') as NodeListOf<HTMLButtonElement>
    )[0];
    confirm.click();
    const action = dispatched.find(
      (a) => a instanceof SetBuilderTeamUserStatus,
    ) as SetBuilderTeamUserStatus;
    expect(action).toBeDefined();
    expect(action.status).toBe('deactivated');
  });
});
