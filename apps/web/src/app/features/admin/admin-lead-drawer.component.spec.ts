import { DIALOG_DATA } from '@angular/cdk/dialog';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { AdminLeadDetail } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { UiDrawerRef, UiToastService } from '@app/shared/ui';
import { AdminLeadDrawerComponent } from './admin-lead-drawer.component';
import { AdminLeadsState } from './admin-leads.state';
import { AdminBuildersState } from './admin-builders.state';
import { AdminAuthState } from './admin-auth.state';
import { ADMIN_PERMISSIONS } from './admin-permissions';

const DETAIL: AdminLeadDetail = {
  id: 'a1',
  name: 'Ava Smith',
  email: 'ava@example.com',
  addressKey: '123 Main St NW, Calgary, AB',
  leadScore: 82,
  status: 'new',
  source: 'embed',
  projectType: 'new_build',
  tenantKey: 'elite-craft',
  timeline: '6-12 months',
  sandbox: false,
  quarantined: false,
  discarded: false,
  createdAt: '2026-09-20T10:00:00.000Z',
  contactConsent: 'in',
  consentUpdatedAt: '2026-09-20T10:00:00.000Z',
  phone: '403-555-0100',
  marketingConsent: false,
  consentTs: '2026-09-20T10:00:00.000Z',
  unsubscribedAt: null,
  nudgeSentAt: null,
  estimate: {
    estimateId: 'est-9',
    addressKey: '123 Main St NW, Calgary, AB',
    projectType: 'new_build',
    sqft: 2400,
    tier: 'premium_plus',
    totalRangeCents: [90000000, 110000000],
    buildRangeCents: [60000000, 80000000],
    landCents: 30000000,
    createdAt: '2026-09-20T10:00:00.000Z',
  },
  magicLinkStatus: 'sent',
  sheetsSyncedAt: null,
  snapshotCount: 1,
  builderId: null,
  notes: [],
  statusHistory: [],
};

/** Poll (with a deadline) for an async UI state — never a fixed sleep. */
async function until(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * #539 — Lead drawer: section order, enum labels, cross-links, and one
 * footer Save that commits status + builder.
 */
describe('AdminLeadDrawerComponent', () => {
  let fixture: ComponentFixture<AdminLeadDrawerComponent>;
  let http: HttpTestingController;
  let store: Store;
  let ref: { titleId: string; setDirty: ReturnType<typeof vi.fn>; requestClose: ReturnType<typeof vi.fn> };
  let toast: ReturnType<typeof vi.fn>;

  async function setup(
    permissions: string[] = [ADMIN_PERMISSIONS.leadsManage, ADMIN_PERMISSIONS.leadsAssign],
    detail: AdminLeadDetail = DETAIL,
  ): Promise<void> {
    TestBed.resetTestingModule();
    ref = { titleId: 'drawer-title', setDirty: vi.fn(), requestClose: vi.fn(() => of(true)) };
    TestBed.configureTestingModule({
      imports: [AdminLeadDrawerComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ConfigService,
        provideStore([AdminLeadsState, AdminBuildersState, AdminAuthState]),
        { provide: DIALOG_DATA, useValue: { id: 'a1' } },
        { provide: UiDrawerRef, useValue: ref },
      ],
    });
    const config = TestBed.inject(ConfigService);
    http = TestBed.inject(HttpTestingController);
    const pending = config.load();
    http.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi: false } });
    await pending;
    store = TestBed.inject(Store);
    store.reset({
      ...store.snapshot(),
      adminAuth: { ...store.selectSnapshot((s) => s.adminAuth), permissions },
    });
    toast = vi.fn();
    vi.spyOn(TestBed.inject(UiToastService), 'show').mockImplementation(toast as never);
    fixture = TestBed.createComponent(AdminLeadDrawerComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET').flush(detail);
    http
      .match((r) => r.url.endsWith('/api/v1/admin/builders'))
      .forEach((r) => r.flush({ builders: [{ id: 'b-1', displayName: 'Elite Craft' }] }));
    http.match((r) => r.url.includes('/comments')).forEach((r) => r.flush({ comments: [] }));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;

  function selects(): HTMLSelectElement[] {
    return Array.from(root().querySelectorAll<HTMLSelectElement>('ui-select select'));
  }

  function choose(select: HTMLSelectElement, value: string): void {
    select.value = value;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  function saveButton(): HTMLButtonElement | null {
    return root().querySelector<HTMLButtonElement>('.ui-drawer__footer-end button[type="submit"]');
  }

  it('orders the sections Pipeline → Contact → Property → Invoices → Notes → Comments → Activity → Record', async () => {
    await setup();
    const headings = Array.from(root().querySelectorAll('.lead-drawer__heading')).map((h) => h.textContent?.trim());
    expect(headings).toEqual([
      'Pipeline',
      'Contact',
      'Property & estimate',
      'Invoices',
      'Notes',
      'Comments',
      'Activity',
      'Record',
    ]);
  });

  it('has exactly one Save, in the footer, disabled until something changes', async () => {
    await setup();
    const saves = Array.from(root().querySelectorAll('button')).filter((b) => b.textContent?.trim() === 'Save');
    expect(saves).toHaveLength(1);
    expect(saveButton()).toBe(saves[0]);
    expect(saveButton()!.disabled).toBe(true);
    // No per-field Apply buttons any more.
    expect(root().textContent).not.toMatch(/Apply/);

    choose(selects()[0], 'contacted');
    expect(saveButton()!.disabled).toBe(false);
    expect(ref.setDirty).toHaveBeenLastCalledWith(true);

    choose(selects()[0], 'new');
    expect(saveButton()!.disabled).toBe(true);
  });

  it('Save commits status then builder in one go and toasts', async () => {
    await setup();
    choose(selects()[0], 'quoting');
    choose(selects()[1], 'b-1');
    saveButton()!.click();
    fixture.detectChanges();

    const status = http.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/status') && r.method === 'PATCH');
    expect(status.request.body).toEqual({ status: 'quoting' });
    status.flush({ ok: true });
    // Status success refetches the detail; keep the builder pick (server value unchanged).
    http.match((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET').forEach((r) =>
      r.flush({ ...DETAIL, status: 'quoting' }),
    );

    let assign: ReturnType<HttpTestingController['match']> = [];
    await until(() => {
      assign.push(...http.match((r) => r.url.endsWith('/api/v1/admin/leads/a1/assign-builder')));
      return assign.length > 0;
    }, 'assign request');
    expect(assign[0].request.body).toEqual({ builderId: 'b-1' });
    assign[0].flush({ ok: true });

    await until(() => toast.mock.calls.length > 0, 'saved toast');
    expect(toast).toHaveBeenCalledWith({ message: 'Lead saved' });
    assign = [];
  });

  it('shows the status error inline and skips the builder when status fails', async () => {
    await setup();
    choose(selects()[0], 'won');
    choose(selects()[1], 'b-1');
    saveButton()!.click();
    http
      .expectOne((r) => r.url.endsWith('/status'))
      .flush({ error: { message: 'Nope' } }, { status: 500, statusText: 'Server Error' });
    http.match((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET').forEach((r) => r.flush(DETAIL));
    await fixture.whenStable();
    fixture.detectChanges();
    http.expectNone((r) => r.url.endsWith('/assign-builder'));
    expect(root().querySelector('.lead-drawer__error[role="alert"]')).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();
  });

  it('maps enums through the label dictionary and links the estimate and invoices', async () => {
    await setup();
    const textContent = root().textContent ?? '';
    expect(textContent).toContain('New build');
    expect(textContent).toContain('Premium plus');
    expect(textContent).toContain('Embed');
    expect(textContent).not.toContain('new_build');
    expect(textContent).not.toContain('premium_plus');
    const links = Array.from(root().querySelectorAll<HTMLAnchorElement>('a.lead-drawer__link')).map((a) =>
      a.getAttribute('href'),
    );
    expect(links).toEqual(['/admin/estimates/est-9', '/admin/billing/invoices']);
  });

  it('read-only staff get disabled selects, a Close button and no Save', async () => {
    await setup([]);
    expect(saveButton()).toBeNull();
    expect(selects().every((s) => s.disabled)).toBe(true);
    expect(root().textContent).toContain('You have read-only access to this lead.');
    const close = root().querySelector<HTMLButtonElement>('.ui-drawer__footer-start button')!;
    expect(close.textContent?.trim()).toBe('Close lead');
    close.click();
    expect(ref.requestClose).toHaveBeenCalled();
  });

  it('adding a note posts it without touching the pipeline form', async () => {
    await setup();
    const textarea = root().querySelector<HTMLTextAreaElement>('#lead-drawer-note')!;
    textarea.value = 'Called, left voicemail';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const add = Array.from(root().querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add note')!;
    add.click();
    const req = http.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/notes') && r.method === 'POST');
    expect(req.request.body).toEqual({ note: 'Called, left voicemail' });
    expect(saveButton()!.disabled).toBe(true);
    req.flush({ ok: true });
  });

  it('clears the selection when the drawer is destroyed', async () => {
    await setup();
    expect(store.selectSnapshot(AdminLeadsState.selectedLeadId)).toBe('a1');
    fixture.destroy();
    expect(store.selectSnapshot(AdminLeadsState.selectedLeadId)).toBeNull();
  });

  it('renders the chip in the drawer header slot', async () => {
    await setup();
    expect(fixture.debugElement.query(By.css('.ui-drawer__sub ui-status-chip'))).toBeTruthy();
  });
});
