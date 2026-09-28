import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import { AdminLeadDetailComponent } from './admin-lead-detail.component';
import { ClearSelectedAdminLead, SelectAdminLead } from './admin-leads.actions';
import { AdminLeadsState } from './admin-leads.state';
import { AdminBuildersState } from './admin-builders.state';
import type { AdminLeadDetail, Builder } from '@feasly/contracts';

const DETAIL: AdminLeadDetail = {
  id: 'a1',
  name: 'Ava Smith',
  email: 'ava@example.com',
  addressKey: '123 Main St NW, Calgary, AB',
  leadScore: 82,
  status: 'new',
  source: 'web',
  projectType: 'new_build',
  tenantKey: null,
  timeline: '6-12 months',
  sandbox: false,
  discarded: false,
  createdAt: '2026-09-20T10:00:00.000Z',
  contactConsent: 'in',
  consentUpdatedAt: '2026-09-20T10:00:00.000Z',
  phone: '403-555-0100',
  marketingConsent: true,
  consentTs: '2026-09-20T10:00:00.000Z',
  quarantined: false,
  unsubscribedAt: null,
  nudgeSentAt: null,
  estimate: {
    estimateId: 'e1',
    addressKey: '123 Main St NW, Calgary, AB',
    projectType: 'new_build',
    sqft: 2100,
    tier: 'Premium',
    totalRangeCents: [45000000, 52000000],
    buildRangeCents: [38000000, 45000000],
    landCents: 7000000,
    createdAt: '2026-09-20T10:01:00.000Z',
  },
  magicLinkStatus: 'sent',
  sheetsSyncedAt: null,
  snapshotCount: 1,
  builderId: null,
  notes: [],
  statusHistory: [],
};

const BUILDER_X: Builder = {
  id: 'b1',
  tenantKey: 'elite-craft',
  businessName: 'Elite Craft Builders',
  displayName: 'Elite Craft',
  email: 'hello@elite.example',
  phone: null,
  logoUrl: null,
  accentColor: '#C8A24B',
  allowedOrigins: ['elite.example'],
  plan: 'flat',
  status: 'active',
  settings: {},
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};

/**
 * Admin lead-detail modal (FE-9): centered dialog, focus trap, Esc close,
 * dropdown + Apply Status two-step flow, inline error + rollback.
 */
describe('AdminLeadDetailComponent', () => {
  let store: Store;
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<AdminLeadDetailComponent>;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AdminLeadDetailComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ConfigService,
        provideStore([AdminLeadsState, AdminBuildersState]),
      ],
    });
    const config = TestBed.inject(ConfigService);
    const http = TestBed.inject(HttpTestingController);
    const pending = config.load();
    http.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi: false } });
    await pending;
    store = TestBed.inject(Store);
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AdminLeadDetailComponent);
  }

  /** Selects the lead and flushes the detail, then renders the modal. */
  async function openLead(detail: AdminLeadDetail = DETAIL): Promise<void> {
    const done = store.dispatch(new SelectAdminLead(detail.id));
    httpMock
      .expectOne((r) => r.url.endsWith(`/api/v1/admin/leads/${detail.id}`) && r.method === 'GET')
      .flush(detail);
    await done.toPromise();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /**
   * Opens the lead and flushes the builders GET the modal dispatches on
   * init (drives the assign-to-builder dropdown).
   */
  async function openLeadWithBuilders(
    detail: AdminLeadDetail = DETAIL,
    builders: Builder[] = [BUILDER_X],
  ): Promise<void> {
    await openLead(detail);
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders') && r.method === 'GET')
      .flush({ builders });
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** Poll an async UI condition until it holds (or the deadline passes). */
  async function waitFor(
    condition: () => boolean,
    label: string,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      fixture.detectChanges();
      if (condition()) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for: ${label}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function assignSelect(): HTMLSelectElement {
    return fixture.debugElement.query(By.css('.lead-modal-card__assign select'))
      .nativeElement;
  }

  function pickBuilder(value: string): void {
    const select = assignSelect();
    select.value = value;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  /** Flushes the assign POST plus the detail refetch the component triggers. */
  function flushAssign(builderId: string | null, detail: AdminLeadDetail): void {
    const post = httpMock.expectOne((r) =>
      r.url.endsWith(`/api/v1/admin/leads/${detail.id}/assign-builder`),
    );
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({ builderId });
    post.flush({ ok: true });
    httpMock
      .expectOne((r) => r.url.endsWith(`/api/v1/admin/leads/${detail.id}`) && r.method === 'GET')
      .flush({ ...detail, builderId });
  }

  function applyButton(): HTMLButtonElement {
    return fixture.debugElement.query(By.css('.lead-modal-card__apply')).nativeElement;
  }

  function statusSelect(): HTMLSelectElement {
    return fixture.debugElement.query(By.css('.lead-modal-card__status-row select'))
      .nativeElement;
  }

  function pickStatus(value: string): void {
    const select = statusSelect();
    select.value = value;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  it('renders as a modal dialog with the lead header', async () => {
    await setup();
    await openLead();

    const dialog = fixture.debugElement.query(By.css('[role="dialog"]'));
    expect(dialog.attributes['aria-modal']).toBe('true');
    const header = fixture.debugElement.query(By.css('.lead-modal-card__header')).nativeElement;
    expect(header.textContent).toContain('Ava Smith');
    expect(header.textContent).toContain('ava@example.com');
    expect(header.textContent).toContain('403-555-0100');
    // Avatar initials.
    expect(header.textContent).toContain('AS');
  });

  it('keeps Apply Status disabled until a different status is picked', async () => {
    await setup();
    await openLead();

    expect(statusSelect().value).toBe('new');
    expect(applyButton().disabled).toBe(true);

    pickStatus('contacted');
    expect(applyButton().disabled).toBe(false);

    // Reverting to the current status disables it again.
    pickStatus('new');
    expect(applyButton().disabled).toBe(true);
  });

  it('applies the new status and updates the modal badge optimistically', async () => {
    await setup();
    await openLead();

    pickStatus('won');
    applyButton().click();
    fixture.detectChanges();

    // Optimistic: the header/detail reflects the new status immediately.
    expect(store.selectSnapshot(AdminLeadsState.detail)?.status).toBe('won');

    const patch = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/status'));
    expect(patch.request.body).toEqual({ status: 'won' });
    patch.flush({ ok: true });
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET')
      .flush({ ...DETAIL, status: 'won' });
    fixture.detectChanges();

    expect(store.selectSnapshot(AdminLeadsState.detail)?.status).toBe('won');
    expect(store.selectSnapshot(AdminLeadsState.statusUpdateError)).toBeNull();
  });

  it('rolls back the dropdown and shows an inline error when apply fails', async () => {
    await setup();
    await openLead();

    pickStatus('lost');
    applyButton().click();
    fixture.detectChanges();

    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/status'))
      .error(new ProgressEvent('error'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Dropdown reverted to the real status; error is inline, not a toast.
    expect(statusSelect().value).toBe('new');
    expect(applyButton().disabled).toBe(true);
    const error = fixture.debugElement.query(By.css('.lead-modal-card__error'));
    expect(error).toBeTruthy();
    expect(error.nativeElement.getAttribute('role')).toBe('alert');
  });

  it('renders the assign-to-builder dropdown with the builders list', async () => {
    await setup();
    await openLeadWithBuilders();

    const assign = assignSelect();
    expect(assign.disabled).toBe(false);
    expect(assign.value).toBe('');
    const labels = Array.from(assign.options).map((o) => o.textContent?.trim());
    expect(labels).toEqual(['Unassigned', 'Elite Craft']);
  });

  it('assigns the lead on change and shows the builder display name', async () => {
    await setup();
    await openLeadWithBuilders();

    pickBuilder('b1');
    flushAssign('b1', DETAIL);

    // The detail refetch updates the assignment; the dropdown and caption
    // follow the server-side builderId (never the optimistic pick).
    await waitFor(
      () => store.selectSnapshot(AdminLeadsState.detail)?.builderId === 'b1',
      'assigned builderId',
    );
    expect(assignSelect().value).toBe('b1');
    const caption = fixture.debugElement.query(By.css('.lead-modal-card__assign-state'));
    expect(caption.nativeElement.textContent).toContain('Currently with Elite Craft');
    expect(store.selectSnapshot(AdminBuildersState.assignError)).toBeNull();
  });

  it('unassigns the lead when Unassigned is picked', async () => {
    await setup();
    await openLeadWithBuilders({ ...DETAIL, builderId: 'b1' });

    expect(assignSelect().value).toBe('b1');

    pickBuilder('');
    flushAssign(null, { ...DETAIL, builderId: 'b1' });

    await waitFor(
      () => store.selectSnapshot(AdminLeadsState.detail)?.builderId === null,
      'unassigned builderId',
    );
    expect(assignSelect().value).toBe('');
  });

  it('rolls the dropdown back and shows an inline error when assign fails', async () => {
    await setup();
    await openLeadWithBuilders();

    pickBuilder('b1');
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/assign-builder'))
      .error(new ProgressEvent('error'));
    // The component still refetches the detail, rolling the dropdown back
    // to the server-side (unassigned) value.
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET')
      .flush(DETAIL);

    await waitFor(
      () => store.selectSnapshot(AdminBuildersState.assignError) !== null,
      'assign error',
    );
    expect(assignSelect().value).toBe('');
    const error = fixture.debugElement.query(By.css('.lead-modal-card__error'));
    expect(error).toBeTruthy();
    expect(error.nativeElement.getAttribute('role')).toBe('alert');
  });

  it('traps Tab focus inside the modal', async () => {
    await setup();
    await openLead();

    const card = fixture.debugElement.query(By.css('.lead-modal-card')).nativeElement;
    // jsdom has no layout (offsetParent is always null); mark the modal's
    // focusable elements as visible the way the trap's filter expects.
    const focusable = Array.from(
      card.querySelectorAll('button:not([disabled]), select:not([disabled]), textarea'),
    ) as HTMLElement[];
    expect(focusable.length).toBeGreaterThan(1);
    for (const el of focusable) {
      Object.defineProperty(el, 'offsetParent', { value: card, configurable: true });
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    // Tab on the last element wraps to the first.
    last.focus();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    // Shift+Tab on the first element wraps to the last.
    first.focus();
    card.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(last);
  });

  it('closes on Escape and returns focus handling to the store', async () => {    await setup();
    await openLead();

    const card = fixture.debugElement.query(By.css('.lead-modal-card')).nativeElement;
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(store.selectSnapshot(AdminLeadsState.selectedLeadId)).toBeNull();
  });

  it('renders every section with no data loss vs the old drawer', async () => {
    await setup();
    await openLead();

    const text = fixture.debugElement.query(By.css('.lead-modal-card')).nativeElement.textContent;
    for (const section of [
      'Pipeline',
      'Contact',
      'Property & estimate',
      'Activity',
      'Notes',
      'Record',
    ]) {
      expect(text).toContain(section);
    }
    // Spot-check fields the old drawer showed.
    for (const field of [
      '123 Main St NW, Calgary, AB', // address
      'Premium', // finish tier
      '$450,000', // total range low
      'Sent', // magic link
      'Lead score',
      '82',
    ]) {
      expect(text).toContain(field);
    }
  });

  it('closes when ClearSelectedAdminLead is dispatched', async () => {
    await setup();
    await openLead();
    store.dispatch(new ClearSelectedAdminLead());
    expect(store.selectSnapshot(AdminLeadsState.selectedLeadId)).toBeNull();
  });
});
