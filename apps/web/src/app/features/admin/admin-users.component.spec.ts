import { InteractivityChecker } from '@angular/cdk/a11y';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminUser, Builder } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { OpenInviteAdminUser } from './admin-users.actions';
import { AdminUsersComponent } from './admin-users.component';
import { AdminAuthState } from './admin-auth.state';
import { AdminBuildersState } from './admin-builders.state';
import { AdminUsersState } from './admin-users.state';
import { ADMIN_PERMISSIONS } from './admin-permissions';

const PROTECTED: AdminUser = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  email: 'karan@feasly.example',
  name: 'Karan',
  status: 'active',
  staffRole: 'super_admin',
  isProtected: true,
  memberships: [],
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};

const INVITED: AdminUser = {
  ...PROTECTED,
  id: '223e4567-e89b-12d3-a456-426614174000',
  email: 'teammate@example.com',
  name: 'Teammate',
  status: 'invited',
  staffRole: 'viewer',
  isProtected: false,
};

const BUILDER_A = { id: 'b-1', displayName: 'Elite Craft' } as Builder;
const BUILDER_B = { id: 'b-2', displayName: 'North Homes' } as Builder;

/** jsdom has no layout, so the CDK sees nothing as visible: treat enabled controls as tabbable. */
const checkerStub: Partial<InteractivityChecker> = {
  isFocusable: (el: HTMLElement) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0,
  isTabbable: (el: HTMLElement) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0,
  isVisible: () => true,
  isDisabled: (el: HTMLElement) => !!(el as HTMLButtonElement).disabled,
};

/** Poll (with a deadline) for an async UI state — never a fixed sleep. */
async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    TestBed.tick();
  }
}

/**
 * AdminUsersComponent (auth/03, review S8 #542): the user table with one
 * ⋮ RowActions menu per row, the single-form edit drawer (one Save), and
 * Deactivate/Delete through the shared ConfirmDialog.
 */
describe('AdminUsersComponent', () => {
  let fixture: ComponentFixture<AdminUsersComponent>;
  let store: Store;
  let httpMock: HttpTestingController;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AdminUsersComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '**', children: [] }]),
        provideLocationMocks(),
        { provide: InteractivityChecker, useValue: checkerStub },
        ConfigService,
        provideStore([AdminUsersState, AdminBuildersState, AdminAuthState]),
      ],
    });
    const config = TestBed.inject(ConfigService);
    const http = TestBed.inject(HttpTestingController);
    const pending = config.load();
    http.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi: false } });
    await pending;
    store = TestBed.inject(Store);
    httpMock = TestBed.inject(HttpTestingController);
    // Existing tests exercise the invite/edit write UI — the session
    // manages users.
    store.reset({
      adminUsers: store.selectSnapshot((s) => s.adminUsers),
      adminBuilders: store.selectSnapshot((s) => s.adminBuilders),
      adminAuth: {
        ...store.selectSnapshot((s) => s.adminAuth),
        permissions: [ADMIN_PERMISSIONS.usersManage],
      },
    });
    fixture = TestBed.createComponent(AdminUsersComponent);
    // Attached so focus and the CDK overlays behave like the real page.
    document.body.appendChild(fixture.nativeElement as HTMLElement);
  }

  function flushInit(users: AdminUser[] = [], builders: Builder[] = []): void {
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/users'))
      .flush({ users, total: users.length, limit: 50, offset: 0 });
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders'))
      .flush({ builders });
    fixture.detectChanges();
  }

  function rows(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('tbody tr'));
  }

  function trigger(row: HTMLElement): HTMLButtonElement | null {
    return row.querySelector('.row-actions__trigger');
  }

  /** Open a row's ⋮ menu and return its items (rendered in the CDK overlay). */
  function openMenu(row: HTMLElement): HTMLButtonElement[] {
    const t = trigger(row);
    expect(t).not.toBeNull();
    t!.click();
    fixture.detectChanges();
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.row-actions__item'));
  }

  function itemLabel(item: HTMLElement): string {
    return item.querySelector('.row-actions__label')?.textContent?.trim() ?? '';
  }

  function menuItem(row: HTMLElement, label: string): HTMLButtonElement {
    const item = openMenu(row).find((i) => itemLabel(i) === label);
    expect(item, `menu item "${label}"`).toBeDefined();
    return item!;
  }

  /** Pick a row-menu item; the menu emits after it closes (microtask). */
  async function choose(row: HTMLElement, label: string, settled: () => boolean): Promise<void> {
    menuItem(row, label).click();
    fixture.detectChanges();
    await until(settled, `after choosing ${label}`);
    fixture.detectChanges();
  }

  function confirmDialog(): HTMLElement | null {
    return document.querySelector('[role="alertdialog"]');
  }

  function dialogButton(scope: HTMLElement, label: string): HTMLButtonElement {
    return Array.from(scope.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === label,
    ) as HTMLButtonElement;
  }

  function drawer(): HTMLElement | null {
    return document.querySelector('.ui-drawer-pane app-admin-user-edit-drawer');
  }

  beforeEach(async () => {
    await setup();
  });

  afterEach(() => {
    fixture.destroy();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => (el.innerHTML = ''));
  });

  it('renders an empty state when there are no users', () => {
    flushInit([]);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No users yet');
    expect(text).toContain('Invite user');
  });

  it('renders rows with one ⋮ menu each, and none for protected users', () => {
    flushInit([PROTECTED, INVITED]);
    const [protectedRow, invitedRow] = rows();
    expect(rows().length).toBe(2);

    // Protected users (e.g. the Karan seed) get no actions at all.
    expect(protectedRow!.textContent).toContain('Karan');
    expect(protectedRow!.querySelectorAll('button').length).toBe(0);

    // Exactly one control per row — the ⋮ trigger, named for the row.
    const buttons = invitedRow!.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(trigger(invitedRow!)!.getAttribute('aria-label')).toBe('Actions for Teammate');
    expect(trigger(invitedRow!)!.getAttribute('aria-haspopup')).toBe('menu');

    const labels = openMenu(invitedRow!).map(itemLabel);
    expect(labels).toEqual(['Edit', 'Resend invite', 'Delete']);
    // Invited (never accepted) users can't be deactivated — only deleted.
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('marks the signed-in admin row with a You badge', () => {
    flushInit([PROTECTED, INVITED]);
    // Simulate the session email matching the protected Karan seed row.
    store.reset({
      adminUsers: store.selectSnapshot((s) => s.adminUsers),
      adminBuilders: store.selectSnapshot((s) => s.adminBuilders),
      adminAuth: { ...store.selectSnapshot((s) => s.adminAuth), email: 'karan@feasly.example' },
    });
    fixture.detectChanges();
    expect(rows()[0]!.querySelector('.users-page__you')).not.toBeNull();
    expect(rows()[1]!.querySelector('.users-page__you')).toBeNull();
  });

  /** #548: the invite modal is a kit modal (CDK overlay, outside the fixture). */
  function inviteModal(): HTMLElement | null {
    return document.querySelector('[data-testid="invite-modal"]');
  }

  it('opens the invite modal off inviteOpen; Cancel closes it and clears the state', async () => {
    flushInit([]);
    expect(inviteModal()).toBeNull();

    store.dispatch(new OpenInviteAdminUser());
    fixture.detectChanges();
    await until(() => inviteModal() !== null, 'invite modal opens');
    const dialog = inviteModal()!.closest('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Invite user');

    const cancel = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Cancel')!;
    cancel.click();
    await until(() => inviteModal() === null, 'invite modal closes');
    expect(store.selectSnapshot(AdminUsersState.inviteOpen)).toBe(false);
  });

  it('dispatches the invite with the form values and closes on success', async () => {
    flushInit([]);
    store.dispatch(new OpenInviteAdminUser());
    fixture.detectChanges();
    await until(() => inviteModal() !== null, 'invite modal opens');

    const setInput = (type: string, value: string) => {
      const input = inviteModal()!.querySelector(`input[type="${type}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    setInput('email', 'new@example.com');
    setInput('text', 'New Teammate');
    TestBed.tick();

    (document.querySelector('[data-testid="invite-submit"]') as HTMLButtonElement).click();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/users/invite'));
    expect(req.request.body).toMatchObject({
      email: 'new@example.com',
      name: 'New Teammate',
      role: 'viewer',
    });
    req.flush({ user: { ...INVITED, email: 'new@example.com', name: 'New Teammate' }, emailSent: true });
    httpMock.match((r) => r.url.endsWith('/api/v1/admin/users'));
    await until(() => inviteModal() === null, 'invite modal closes after success');
    expect(store.selectSnapshot(AdminUsersState.inviteOpen)).toBe(false);
  });

  it('a builder role asks for the organization before sending', async () => {
    flushInit([], [BUILDER_A, BUILDER_B]);
    store.dispatch(new OpenInviteAdminUser());
    fixture.detectChanges();
    await until(() => inviteModal() !== null, 'invite modal opens');

    const fill = (type: string, value: string) => {
      const input = inviteModal()!.querySelector(`input[type="${type}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    fill('email', 'pm@elitecraft.example');
    fill('text', 'Project Manager');
    const role = inviteModal()!.querySelector('select') as HTMLSelectElement;
    role.value = 'builder_member';
    role.dispatchEvent(new Event('change'));
    await until(() => inviteModal()!.querySelectorAll('select').length === 2, 'organization select appears');

    (document.querySelector('[data-testid="invite-submit"]') as HTMLButtonElement).click();
    TestBed.tick();
    httpMock.expectNone((r) => r.url.endsWith('/api/v1/admin/users/invite'));
    await until(() => (inviteModal()!.textContent ?? '').includes('Choose the builder organization.'), 'org error');

    const org = inviteModal()!.querySelectorAll('select')[1] as HTMLSelectElement;
    org.value = BUILDER_B.id;
    org.dispatchEvent(new Event('change'));
    TestBed.tick();
    (document.querySelector('[data-testid="invite-submit"]') as HTMLButtonElement).click();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/users/invite'));
    expect(req.request.body).toMatchObject({ role: 'builder_member', builderId: BUILDER_B.id });
  });

  it('switching back to a staff role clears the org requirement so Send works', async () => {
    flushInit([], [BUILDER_A, BUILDER_B]);
    store.dispatch(new OpenInviteAdminUser());
    fixture.detectChanges();
    await until(() => inviteModal() !== null, 'invite modal opens');

    const fill = (type: string, value: string) => {
      const input = inviteModal()!.querySelector(`input[type="${type}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    fill('email', 'ops@example.com');
    fill('text', 'Ops Person');
    const role = inviteModal()!.querySelector('select') as HTMLSelectElement;
    role.value = 'builder_member';
    role.dispatchEvent(new Event('change'));
    await until(() => inviteModal()!.querySelectorAll('select').length === 2, 'organization select appears');

    (document.querySelector('[data-testid="invite-submit"]') as HTMLButtonElement).click();
    TestBed.tick();
    httpMock.expectNone((r) => r.url.endsWith('/api/v1/admin/users/invite'));
    await until(() => (inviteModal()!.textContent ?? '').includes('Choose the builder organization.'), 'org error');

    role.value = 'viewer';
    role.dispatchEvent(new Event('change'));
    await until(() => inviteModal()!.querySelectorAll('select').length === 1, 'organization select hides');
    (document.querySelector('[data-testid="invite-submit"]') as HTMLButtonElement).click();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/users/invite'));
    expect(req.request.body).toMatchObject({ role: 'viewer' });
    expect(req.request.body.builderId).toBeUndefined();
  });

  it('keeps the modal open with the error inline when the invite fails', async () => {
    flushInit([]);
    store.dispatch(new OpenInviteAdminUser());
    fixture.detectChanges();
    await until(() => inviteModal() !== null, 'invite modal opens');

    const email = inviteModal()!.querySelector('input[type="email"]') as HTMLInputElement;
    email.value = 'dupe@example.com';
    email.dispatchEvent(new Event('input'));
    const name = inviteModal()!.querySelector('input[type="text"]') as HTMLInputElement;
    name.value = 'Dupe';
    name.dispatchEvent(new Event('input'));
    TestBed.tick();
    (document.querySelector('[data-testid="invite-submit"]') as HTMLButtonElement).click();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/users/invite'))
      .flush({ error: { code: 'CONFLICT', message: 'That email already has an account.' } }, { status: 409, statusText: 'Conflict' });
    await until(() => !!inviteModal()?.querySelector('[role="alert"]'), 'inline invite error');
    const message = store.selectSnapshot(AdminUsersState.inviteError);
    expect(message).toBeTruthy();
    expect(inviteModal()!.querySelector('[role="alert"]')!.textContent).toContain(message!);
    expect(store.selectSnapshot(AdminUsersState.inviteOpen)).toBe(true);
  });

  it('Resend invite from the row menu posts the resend', async () => {
    flushInit([INVITED]);
    menuItem(rows()[0]!, 'Resend invite').click();
    fixture.detectChanges();
    await until(
      () => httpMock.match((r) => r.url.endsWith(`/api/v1/admin/users/${INVITED.id}/resend-invite`)).length === 1,
      'resend POST',
    );
  });

  /**
   * #542 AC1 — one form, one Save: name, staff role and builder
   * organizations live in a single drawer form with one sticky footer.
   */
  describe('edit drawer (one Save)', () => {
    const MEMBER: AdminUser = {
      ...INVITED,
      id: '723e4567-e89b-12d3-a456-426614174000',
      email: 'member@example.com',
      name: 'Member',
      status: 'active',
      staffRole: null,
      memberships: [{ builderId: BUILDER_A.id, role: 'builder_member' }],
    };

    function isPatch(r: { url: string; method: string }): boolean {
      return r.url.endsWith(`/api/v1/admin/users/${MEMBER.id}`) && r.method === 'PATCH';
    }

    async function openDrawer(): Promise<HTMLElement> {
      flushInit([MEMBER], [BUILDER_A, BUILDER_B]);
      await choose(rows()[0]!, 'Edit', () => drawer() !== null);
      return drawer()!;
    }

    function type(scope: HTMLElement, selector: string, value: string): void {
      const input = scope.querySelector(selector) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }

    function check(scope: HTMLElement, builderName: string): void {
      const label = Array.from(scope.querySelectorAll('.user-drawer__check')).find((l) =>
        (l.textContent ?? '').includes(builderName),
      ) as HTMLElement;
      (label.querySelector('input') as HTMLInputElement).click();
      fixture.detectChanges();
    }

    function submit(scope: HTMLElement): void {
      (scope.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { cancelable: true }),
      );
      fixture.detectChanges();
    }

    it('renders one form with a single Save in the sticky footer', async () => {
      const d = await openDrawer();
      expect(d.querySelector('.ui-drawer__title')!.textContent!.trim()).toBe('Edit Member');
      expect(d.querySelectorAll('form').length).toBe(1);
      const footer = d.querySelector('.ui-drawer__footer') as HTMLElement;
      const labels = Array.from(footer.querySelectorAll('button')).map((b) => b.textContent!.trim());
      expect(labels).toEqual(['Cancel', 'Save']);
      expect(d.querySelectorAll('button[type="submit"]').length).toBe(1);
      expect(d.textContent).not.toContain('Save organizations');
      expect(d.textContent).not.toContain('Save changes');
      // Fields from both former forms share the one form.
      expect(d.querySelector('input[formcontrolname="name"]')).not.toBeNull();
      expect(d.querySelector('select[formcontrolname="role"]')).not.toBeNull();
      expect(d.querySelectorAll('.user-drawer__membership').length).toBe(2);
      // The header has an × close.
      expect(d.querySelector('.ui-drawer__close')).not.toBeNull();
    });

    it('Save sends one PATCH with the name and membership changes together', async () => {
      const d = await openDrawer();
      type(d, 'input[formcontrolname="name"]', 'Member Renamed');
      check(d, 'North Homes');
      submit(d);

      const req = httpMock.expectOne(isPatch);
      expect(req.request.body).toEqual({
        name: 'Member Renamed',
        memberships: [
          { builderId: BUILDER_A.id, role: 'builder_member' },
          { builderId: BUILDER_B.id, role: 'builder_member' },
        ],
      });
      req.flush({ ...MEMBER, name: 'Member Renamed' });
      fixture.detectChanges();
      await until(() => drawer() === null, 'drawer closes after save');
      expect(store.selectSnapshot(AdminUsersState.editingId)).toBeNull();
      expect(fixture.nativeElement.textContent).toContain('member@example.com updated.');
    });

    it('omits unchanged fields — memberships are never re-sent untouched', async () => {
      const d = await openDrawer();
      type(d, 'input[formcontrolname="name"]', 'Just A Rename');
      submit(d);
      const req = httpMock.expectOne(isPatch);
      expect(req.request.body).toEqual({ name: 'Just A Rename' });
      req.flush({ ...MEMBER, name: 'Just A Rename' });
    });

    it('Save with no changes closes without a request', async () => {
      const d = await openDrawer();
      submit(d);
      httpMock.expectNone(isPatch);
      await until(() => drawer() === null, 'drawer closes');
    });

    it('a failed save keeps the drawer open with the backend message', async () => {
      const d = await openDrawer();
      type(d, 'input[formcontrolname="name"]', 'Nope');
      submit(d);
      httpMock
        .expectOne(isPatch)
        .flush({ message: 'You cannot change your own memberships.' }, { status: 409, statusText: 'Conflict' });
      fixture.detectChanges();
      expect(drawer()).not.toBeNull();
      expect(d.querySelector('.user-drawer__error')!.textContent!.trim()).toBe(
        'You cannot change your own memberships.',
      );
    });
  });

  /**
   * auth/07 — last-admin protection: the sole remaining active staff
   * admin's role select and Deactivate action are disabled, each with
   * the exact story explainer. The backend 409 is the real enforcement.
   */
  describe('last-admin protection', () => {
    const SOLE_ADMIN: AdminUser = {
      id: '323e4567-e89b-12d3-a456-426614174000',
      email: 'sole@example.com',
      name: 'Sole',
      status: 'active',
      staffRole: 'admin',
      isProtected: false,
      memberships: [],
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
    };
    const SECOND_ADMIN: AdminUser = {
      ...SOLE_ADMIN,
      id: '423e4567-e89b-12d3-a456-426614174000',
      email: 'second@example.com',
      name: 'Second',
    };

    function expectLockedDeactivate(row: HTMLElement): HTMLButtonElement {
      const item = menuItem(row, 'Deactivate');
      expect(item.getAttribute('aria-disabled')).toBe('true');
      const hintId = item.getAttribute('aria-describedby');
      expect(hintId).toBeTruthy();
      expect(document.getElementById(hintId!)!.textContent!.trim()).toBe(
        'Every organization needs at least one active administrator.',
      );
      return item;
    }

    it('sole staff admin: Deactivate is disabled with the explainer', async () => {
      flushInit([SOLE_ADMIN]);
      const row = rows()[0]!;
      const item = expectLockedDeactivate(row);
      // Selecting the disabled item does nothing.
      item.click();
      fixture.detectChanges();
      await Promise.resolve();
      expect(confirmDialog()).toBeNull();
      httpMock.expectNone((r) => r.method === 'PATCH');
    });

    it('sole staff admin: the edit drawer role select is disabled with the ⓘ tooltip explainer', async () => {
      flushInit([SOLE_ADMIN]);
      await choose(rows()[0]!, 'Edit', () => drawer() !== null);
      const d = drawer()!;
      const select = d.querySelector('select[formcontrolname="role"]') as HTMLSelectElement;
      expect(select.disabled).toBe(true);
      const tip = d.querySelector('app-info-tooltip');
      expect(tip).not.toBeNull();
      expect(select.getAttribute('aria-describedby')).toBe(`last-admin-role-${SOLE_ADMIN.id}`);
      (tip!.querySelector('.info-tooltip__trigger') as HTMLButtonElement).click();
      fixture.detectChanges();
      await until(() => d.querySelector('.info-tooltip__bubble') !== null, 'tooltip bubble');
      expect(d.querySelector('.info-tooltip__bubble')!.textContent!.trim()).toBe(
        "You can't change the role of the last administrator. Add another administrator first.",
      );
    });

    it('two staff admins: Deactivate stays enabled with no explainer', () => {
      flushInit([SOLE_ADMIN, SECOND_ADMIN]);
      const item = menuItem(rows()[0]!, 'Deactivate');
      expect(item.getAttribute('aria-disabled')).not.toBe('true');
      expect(item.getAttribute('aria-describedby')).toBeNull();
    });

    it('pending and deactivated admins never count toward the guard', () => {
      flushInit([
        SOLE_ADMIN,
        { ...SECOND_ADMIN, status: 'disabled' },
        {
          ...SECOND_ADMIN,
          id: '523e4567-e89b-12d3-a456-426614174000',
          email: 'pending@example.com',
          name: 'Pending',
          status: 'invited',
        },
      ]);
      expectLockedDeactivate(rows()[0]!);
    });

    it('a backend 409 race surfaces inline on the targeted row, not as a banner', async () => {
      // Two admins so Deactivate is enabled; the backend still refuses
      // with 409 (the race the disabled UI can't prevent).
      flushInit([SOLE_ADMIN, SECOND_ADMIN]);
      const row = rows()[0]!;
      await choose(row, 'Deactivate', () => confirmDialog() !== null);
      dialogButton(confirmDialog()!, 'Deactivate').click();
      fixture.detectChanges();
      httpMock
        .expectOne((r) => r.url.endsWith(`/api/v1/admin/users/${SOLE_ADMIN.id}`) && r.method === 'PATCH')
        .flush(
          {
            type: 'urn:feasly:errors:last-admin',
            title: 'Last administrator',
            status: 409,
            message: 'Every organization needs at least one active administrator.',
          },
          { status: 409, statusText: 'Conflict' },
        );
      fixture.detectChanges();
      const note = row.querySelector('.users-page__note--error') as HTMLElement;
      expect(note?.textContent?.trim()).toBe(
        'Every organization needs at least one active administrator.',
      );
      // Row-tagged failures never use the generic banner.
      expect(fixture.nativeElement.querySelector('.users-page__state--error')).toBeNull();
    });
  });

  /**
   * #473 / #542 AC2 — Deactivate signs the user out everywhere, so it goes
   * through the shared ConfirmDialog naming the user and the consequence,
   * with Cancel focused by default.
   */
  describe('deactivate confirmation (ConfirmDialog)', () => {
    const ACTIVE: AdminUser = {
      ...INVITED,
      id: '623e4567-e89b-12d3-a456-426614174000',
      email: 'active@example.com',
      name: 'Active Teammate',
      status: 'active',
    };

    function isPatch(r: { url: string; method: string }): boolean {
      return r.url.endsWith(`/api/v1/admin/users/${ACTIVE.id}`) && r.method === 'PATCH';
    }

    async function openConfirm(): Promise<HTMLElement> {
      flushInit([ACTIVE]);
      await choose(rows()[0]!, 'Deactivate', () => confirmDialog() !== null);
      return confirmDialog()!;
    }

    it('choosing Deactivate opens a confirmation instead of deactivating', async () => {
      const d = await openConfirm();
      httpMock.expectNone(isPatch);
      expect(d.getAttribute('aria-modal')).toBe('true');
      expect(d.textContent).toContain('Deactivate Active Teammate?');
      const text = d.textContent!.replace(/\s+/g, ' ');
      expect(text).toContain('Active Teammate (active@example.com)');
      expect(text).toContain('signed out everywhere immediately');
    });

    it('focuses Cancel by default', async () => {
      const d = await openConfirm();
      await until(() => document.activeElement === dialogButton(d, 'Cancel'), 'Cancel focused');
    });

    it('Cancel closes without deactivating', async () => {
      const d = await openConfirm();
      dialogButton(d, 'Cancel').click();
      fixture.detectChanges();
      await until(() => confirmDialog() === null, 'dialog closed');
      httpMock.expectNone(isPatch);
    });

    it('confirming sends the deactivate PATCH', async () => {
      const d = await openConfirm();
      dialogButton(d, 'Deactivate').click();
      fixture.detectChanges();

      const req = httpMock.expectOne(isPatch);
      expect(req.request.body).toEqual({ status: 'disabled' });
      req.flush({ ...ACTIVE, status: 'disabled' });
      fixture.detectChanges();

      await until(() => confirmDialog() === null, 'dialog closed');
      expect(fixture.nativeElement.textContent).toContain(
        'active@example.com deactivated — signed out everywhere.',
      );
    });
  });

  /** #542 AC2 — Delete (pending invites only) is a type-to-confirm ConfirmDialog. */
  describe('delete confirmation (ConfirmDialog)', () => {
    function isDelete(r: { url: string; method: string }): boolean {
      return r.url.endsWith(`/api/v1/admin/users/${INVITED.id}`) && r.method === 'DELETE';
    }

    async function openConfirm(): Promise<HTMLElement> {
      flushInit([INVITED]);
      await choose(rows()[0]!, 'Delete', () => confirmDialog() !== null);
      return confirmDialog()!;
    }

    it('names the user and keeps Delete disabled until the email is typed', async () => {
      const d = await openConfirm();
      expect(d.textContent).toContain(`Delete ${INVITED.email}?`);
      expect(d.textContent).toContain("This can't be undone.");
      const verb = dialogButton(d, 'Delete');
      expect(verb.disabled).toBe(true);

      const input = d.querySelector('input') as HTMLInputElement;
      input.value = 'wrong@example.com';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      TestBed.tick();
      expect(verb.disabled).toBe(true);

      input.value = INVITED.email;
      input.dispatchEvent(new Event('input'));
      TestBed.tick();
      await until(() => !verb.disabled, 'verb enabled');
      verb.click();
      fixture.detectChanges();

      const req = httpMock.expectOne(isDelete);
      req.flush({ deleted: true });
      fixture.detectChanges();
      expect(rows()[0]!.textContent).toContain('No users yet');
      expect(fixture.nativeElement.textContent).toContain(`${INVITED.email} deleted.`);
    });

    it('Cancel closes without deleting', async () => {
      const d = await openConfirm();
      dialogButton(d, 'Cancel').click();
      fixture.detectChanges();
      await until(() => confirmDialog() === null, 'dialog closed');
      httpMock.expectNone(isDelete);
    });
  });

  describe('viewer permission gating (QA admin-console finding 8)', () => {
    it('hides invite and row actions from viewers but keeps the table', () => {
      store.reset({
        adminUsers: store.selectSnapshot((s) => s.adminUsers),
        adminBuilders: store.selectSnapshot((s) => s.adminBuilders),
        adminAuth: {
          ...store.selectSnapshot((s) => s.adminAuth),
          permissions: [],
        },
      });
      flushInit([PROTECTED, INVITED]);

      const page = fixture.nativeElement as HTMLElement;
      expect(page.textContent).toContain('Teammate');
      expect(page.querySelector('.users-page__primary')).toBeNull();
      expect(page.querySelectorAll('tbody button').length).toBe(0);
    });
  });

  /** #538: ⌘K hits and EntityLinks open a user's drawer via `?open=<id>`. */
  describe('?open=<id> deep link', () => {
    it('opens that user\'s edit drawer once the list loads', async () => {
      await setup();
      const router = TestBed.inject(Router);
      await router.navigateByUrl(`/admin/users?open=${INVITED.id}`);
      flushInit([PROTECTED, INVITED], [BUILDER_A]);
      await until(() => drawer() !== null, 'drawer opens from ?open');
      expect(drawer()!.closest('.ui-drawer-pane')!.querySelector('.ui-drawer__title')!.textContent!.trim()).toBe(
        'Edit Teammate',
      );
    });

    it('drops an ?open naming an unknown user', async () => {
      await setup();
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/admin/users?open=nope');
      flushInit([PROTECTED], [BUILDER_A]);
      await until(() => !router.url.includes('open='), 'unknown id dropped');
      expect(drawer()).toBeNull();
    });
  });
});
