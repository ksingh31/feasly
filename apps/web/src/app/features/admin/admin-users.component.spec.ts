import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminUser } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { InfoTooltipComponent } from '../../shared/components/info-tooltip';
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

    function deactivateButton(row: HTMLElement): HTMLButtonElement {
      const button = Array.from(row.querySelectorAll('button')).find((b) =>
        (b.textContent ?? '').includes('Deactivate'),
      ) as HTMLButtonElement;
      expect(button).toBeDefined();
      return button;
    }

    /** The auth/07 ⓘ tooltip rendered inside a scope (row or modal). */
    function lastAdminTooltip(scope: HTMLElement): InfoTooltipComponent | null {
      const found = fixture.debugElement
        .queryAll(By.directive(InfoTooltipComponent))
        .find((d) => scope.contains(d.nativeElement as Node));
      return (found?.componentInstance as InfoTooltipComponent | undefined) ?? null;
    }

    it('sole staff admin: Deactivate is disabled with the ⓘ tooltip explainer', () => {
      flushInit([SOLE_ADMIN]);
      const row = fixture.nativeElement.querySelectorAll(
        'tbody tr',
      )[0] as HTMLElement;
      const button = deactivateButton(row);
      expect(button.disabled).toBe(true);
      const tip = lastAdminTooltip(row);
      expect(tip).not.toBeNull();
      expect(tip!.text()).toBe(
        'Every organization needs at least one active administrator.',
      );
      // The trigger icon renders beside the disabled action…
      expect(
        row.querySelector('app-info-tooltip .info-tooltip__trigger'),
      ).not.toBeNull();
      // …and the control points at the tooltip for screen readers.
      expect(button.getAttribute('aria-describedby')).toBe(tip!.tooltipId);
      // No inline explainer text under the control anymore.
      expect(row.querySelector('.users-page__note:not(.users-page__note--error)')).toBeNull();
    });

    it('sole staff admin: the tooltip opens with the exact copy on demand', async () => {
      flushInit([SOLE_ADMIN]);
      const row = fixture.nativeElement.querySelectorAll(
        'tbody tr',
      )[0] as HTMLElement;
      const trigger = row.querySelector(
        'app-info-tooltip .info-tooltip__trigger',
      ) as HTMLButtonElement;
      trigger.click();
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
      const bubble = row.querySelector(
        '.info-tooltip__bubble',
      ) as HTMLElement;
      expect(bubble).not.toBeNull();
      expect(bubble.getAttribute('role')).toBe('tooltip');
      expect(bubble.textContent?.trim()).toBe(
        'Every organization needs at least one active administrator.',
      );
    });

    it('sole staff admin: the edit drawer role select is disabled with the ⓘ tooltip explainer', () => {
      flushInit([SOLE_ADMIN]);
      // Open the drawer through the real UI path (Edit button → openEdit).
      const row = fixture.nativeElement.querySelectorAll(
        'tbody tr',
      )[0] as HTMLElement;
      const edit = Array.from(row.querySelectorAll('button')).find((b) =>
        (b.textContent ?? '').includes('Edit'),
      ) as HTMLButtonElement;
      edit.click();
      fixture.detectChanges();
      const modal = fixture.nativeElement.querySelector(
        '.users-page__modal',
      ) as HTMLElement;
      const select = modal.querySelector(
        'select[formcontrolname="role"]',
      ) as HTMLSelectElement;
      expect(select).not.toBeNull();
      expect(select.disabled).toBe(true);
      const tip = lastAdminTooltip(modal);
      expect(tip).not.toBeNull();
      expect(tip!.text()).toBe(
        "You can't change the role of the last administrator. Add another administrator first.",
      );
      expect(select.getAttribute('aria-describedby')).toBe(tip!.tooltipId);
      expect(
        modal.querySelector('.users-page__note:not(.users-page__note--error)'),
      ).toBeNull();
    });

    it('two staff admins: controls stay enabled and no tooltip shows', () => {
      flushInit([SOLE_ADMIN, SECOND_ADMIN]);
      const row = fixture.nativeElement.querySelectorAll(
        'tbody tr',
      )[0] as HTMLElement;
      expect(deactivateButton(row).disabled).toBe(false);
      expect(row.querySelector('app-info-tooltip')).toBeNull();
    });

    it('pending and deactivated admins never count toward the guard', () => {
      flushInit([
        SOLE_ADMIN,
        {
          ...SECOND_ADMIN,
          status: 'disabled',
        },
        {
          ...SECOND_ADMIN,
          id: '523e4567-e89b-12d3-a456-426614174000',
          email: 'pending@example.com',
          name: 'Pending',
          status: 'invited',
        },
      ]);
      const row = fixture.nativeElement.querySelectorAll(
        'tbody tr',
      )[0] as HTMLElement;
      expect(deactivateButton(row).disabled).toBe(true);
      const tip = lastAdminTooltip(row);
      expect(tip).not.toBeNull();
      expect(tip!.text()).toBe(
        'Every organization needs at least one active administrator.',
      );
    });

    it('a backend 409 race surfaces inline on the targeted row, not as a banner', () => {
      // Two admins so the Deactivate action is enabled; the backend still
      // refuses with 409 (the race the disabled UI can't prevent).
      flushInit([SOLE_ADMIN, SECOND_ADMIN]);
      const row = fixture.nativeElement.querySelectorAll(
        'tbody tr',
      )[0] as HTMLElement;
      deactivateButton(row).click();
      fixture.detectChanges();
      const req = httpMock.expectOne(
        (r) => r.url.endsWith(`/api/v1/admin/users/${SOLE_ADMIN.id}`) && r.method === 'PATCH',
      );
      req.flush(
        {
          type: 'urn:feasly:errors:last-admin',
          title: 'Last administrator',
          status: 409,
          message: 'Every organization needs at least one active administrator.',
        },
        { status: 409, statusText: 'Conflict' },
      );
      fixture.detectChanges();
      const note = row.querySelector(
        '.users-page__note--error',
      ) as HTMLElement;
      expect(note?.textContent?.trim()).toBe(
        'Every organization needs at least one active administrator.',
      );
      // Row-tagged failures never use the generic banner.
      expect(
        fixture.nativeElement.querySelector('.users-page__state--error'),
      ).toBeNull();
    });
  });
});
