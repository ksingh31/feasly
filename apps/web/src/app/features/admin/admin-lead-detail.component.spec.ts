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
import type { AdminLeadDetail } from '@feasly/contracts';

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
  notes: [],
  statusHistory: [],
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
        provideStore([AdminLeadsState]),
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

  it('renders assign-to-builder as a disabled visual-only placeholder', async () => {
    await setup();
    await openLead();

    const assign = fixture.debugElement.query(By.css('.lead-modal-card__assign select'))
      .nativeElement as HTMLSelectElement;
    expect(assign.disabled).toBe(true);
    expect(assign.value).toBe('Unassigned');
  });

  it('closes on Escape and returns focus handling to the store', async () => {
    await setup();
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
