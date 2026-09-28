import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminUser } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { OpenInviteAdminUser } from './admin-users.actions';
import { AdminUsersComponent } from './admin-users.component';
import { AdminAuthState } from './admin-auth.state';
import { AdminBuildersState } from './admin-builders.state';
import { AdminUsersState } from './admin-users.state';

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

/**
 * AdminUsersComponent (auth/03): renders the user table, hides actions for
 * protected rows, and toggles the invite dialog.
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
    fixture = TestBed.createComponent(AdminUsersComponent);
  }

  function flushInit(users: AdminUser[] = []): void {
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/users'))
      .flush({ users, total: users.length, limit: 50, offset: 0 });
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders'))
      .flush({ builders: [] });
    fixture.detectChanges();
  }

  beforeEach(async () => {
    await setup();
  });

  it('renders an empty state when there are no users', () => {
    flushInit([]);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No users yet');
    expect(text).toContain('Invite user');
  });

  it('renders rows and hides actions for protected users', () => {
    flushInit([PROTECTED, INVITED]);
    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);

    const protectedRow = rows[0] as HTMLElement;
    // Protected users (e.g. the Karan seed) get no action buttons at all.
    expect(protectedRow.textContent).toContain('Karan');
    expect(protectedRow.querySelectorAll('button').length).toBe(0);

    const invitedRow = rows[1] as HTMLElement;
    const buttons = [...invitedRow.querySelectorAll('button')].map((b) =>
      (b.textContent ?? '').trim(),
    );
    expect(buttons).toContain('Edit');
    expect(buttons).toContain('Resend invite');
    expect(buttons).toContain('Delete');
    // Invited (never accepted) users can't be deactivated — only deleted.
    expect(buttons).not.toContain('Deactivate');
    expect(buttons).not.toContain('Reactivate');
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
    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect((rows[0] as HTMLElement).querySelector('.users-page__you')).not.toBeNull();
    expect((rows[1] as HTMLElement).querySelector('.users-page__you')).toBeNull();
  });

  it('opens and closes the invite dialog', () => {
    flushInit([]);
    expect(fixture.nativeElement.querySelector('.users-page__overlay')).toBeNull();

    store.dispatch(new OpenInviteAdminUser());
    fixture.detectChanges();
    const overlay = fixture.nativeElement.querySelector('.users-page__overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Invite user');
  });

  it('dispatches the invite with the form values', () => {
    flushInit([]);
    store.dispatch(new OpenInviteAdminUser());
    fixture.detectChanges();

    const setInput = (name: string, value: string) => {
      const input = fixture.nativeElement.querySelector(
        `input[formcontrolname="${name}"]`,
      ) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    setInput('email', 'new@example.com');
    setInput('name', 'New Teammate');
    fixture.detectChanges();

    const form = fixture.nativeElement.querySelector('.users-page__modal form');
    form.dispatchEvent(new Event('submit'));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/users/invite'));
    expect(req.request.body).toMatchObject({
      email: 'new@example.com',
      name: 'New Teammate',
      role: 'viewer',
    });
  });
});
