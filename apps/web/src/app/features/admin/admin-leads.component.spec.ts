import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import { AdminLeadsComponent } from './admin-leads.component';
import { AdminLeadsState } from './admin-leads.state';
// The lead-detail modal (rendered by this page) reads AdminBuildersState
// for its assign-to-builder dropdown — registered at the /admin route in
// production, so the TestBed mirrors that here.
import { AdminBuildersState } from './admin-builders.state';
import { AdminAuthState } from './admin-auth.state';
import { ADMIN_PERMISSIONS } from './admin-permissions';
import type { AdminLeadListItem } from '@feasly/contracts';

const LEAD_A: AdminLeadListItem = {
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
  quarantined: false,
  discarded: false,
  createdAt: '2026-09-20T10:00:00.000Z',
  contactConsent: 'in',
  consentUpdatedAt: '2026-09-20T10:00:00.000Z',
};

const EMPTY_COUNTS = { new: 0, contacted: 0, quoting: 0, won: 0, lost: 0 };

function listResponse(leads: AdminLeadListItem[], totalCount: number, statusCounts = EMPTY_COUNTS) {
  return { leads, nextCursor: null, totalCount, statusCounts };
}

/**
 * Admin leads list (FE-9): three filters, pipeline totals row, cards,
 * designed empty state, row click opens the modal.
 */
describe('AdminLeadsComponent', () => {
  let store: Store;
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<AdminLeadsComponent>;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AdminLeadsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ConfigService,
        // AdminAuthState is in the root store in production (app.config.ts);
        // the quarantine approve/discard buttons gate on its permissions.
        provideStore([AdminLeadsState, AdminBuildersState, AdminAuthState]),
      ],
    });
    const config = TestBed.inject(ConfigService);
    const http = TestBed.inject(HttpTestingController);
    const pending = config.load();
    http.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi: false } });
    await pending;
    store = TestBed.inject(Store);
    httpMock = TestBed.inject(HttpTestingController);
    // Existing tests assert the write UI — the session manages leads.
    store.reset({
      adminLeads: store.selectSnapshot((s) => s.adminLeads),
      adminBuilders: store.selectSnapshot((s) => s.adminBuilders),
      adminAuth: {
        ...store.selectSnapshot((s) => s.adminAuth),
        permissions: [ADMIN_PERMISSIONS.leadsManage],
      },
    });
    fixture = TestBed.createComponent(AdminLeadsComponent);
  }

  /** Flushes the initial list load and renders. */
  async function loadList(
    leads: AdminLeadListItem[] = [LEAD_A],
    totalCount = leads.length,
    statusCounts = { new: totalCount, contacted: 0, quoting: 0, won: 0, lost: 0 },
  ): Promise<void> {
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads'))
      .flush(listResponse(leads, totalCount, statusCounts));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('shows exactly the three streamlined filters', async () => {
    await setup();
    await loadList();

    const filters = fixture.debugElement.queryAll(By.css('.leads-page__filter'));
    expect(filters.length).toBe(3);
    const labels = filters.map((f) => f.nativeElement.textContent);
    expect(labels.join('|')).toContain('Search');
    expect(labels.join('|')).toContain('Status');
    expect(labels.join('|')).toContain('Assigned');
  });

  it('selecting a builder in the Assigned filter sends builderId to the backend', async () => {
    await setup();
    fixture.detectChanges();
    // Initial leads load + builders load (the Assigned filter options).
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads'))
      .flush(listResponse([LEAD_A], 1));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders'))
      .flush({
        builders: [
          { id: '123e4567-e89b-12d3-a456-426614174000', displayName: 'Elite Craft' },
        ],
      });
    await fixture.whenStable();
    fixture.detectChanges();

    const selects = fixture.debugElement.queryAll(
      By.css('.leads-page__filter select'),
    );
    const assignedSelect = selects[1].nativeElement as HTMLSelectElement;
    assignedSelect.value = '123e4567-e89b-12d3-a456-426614174000';
    assignedSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req.request.params.get('builderId')).toBe(
      '123e4567-e89b-12d3-a456-426614174000',
    );
    req.flush(listResponse([], 0));
    await fixture.whenStable();
    fixture.detectChanges();

    // "Unassigned" sends the sentinel the backend maps to IS NULL.
    assignedSelect.value = 'unassigned';
    assignedSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const req2 = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req2.request.params.get('builderId')).toBe('unassigned');
    req2.flush(listResponse([], 0));
  });

  it('renders pipeline totals from statusCounts', async () => {
    await setup();
    await loadList([LEAD_A], 3, { new: 1, contacted: 2, quoting: 0, won: 0, lost: 0 });

    const totals = fixture.debugElement.queryAll(By.css('.leads-page__total'));
    expect(totals.length).toBe(5);
    const text = totals.map((t) => t.nativeElement.textContent).join(' | ');
    expect(text).toContain('New');
    expect(text).toContain('1');
    expect(text).toContain('Contacted');
    expect(text).toContain('2');
  });

  it('clicking a pipeline total filters the list by that status', async () => {
    await setup();
    await loadList([LEAD_A], 3, { new: 1, contacted: 2, quoting: 0, won: 0, lost: 0 });

    const totals = fixture.debugElement.queryAll(By.css('.leads-page__total'));
    const wonTotal = totals.find((t) => t.nativeElement.textContent.includes('Won'))!;
    wonTotal.nativeElement.click();
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req.request.params.get('status')).toBe('won');
    req.flush(listResponse([], 0));
    await fixture.whenStable();
    fixture.detectChanges();

    // Clicking again clears the status filter.
    wonTotal.nativeElement.click();
    const req2 = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req2.request.params.get('status')).toBeNull();
    req2.flush(listResponse([], 0));
  });

  it('changing the status filter reloads the list', async () => {
    await setup();
    await loadList();

    const select = fixture.debugElement.query(By.css('.leads-page__filter select'))
      .nativeElement as HTMLSelectElement;
    select.value = 'contacted';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req.request.params.get('status')).toBe('contacted');
    req.flush(listResponse([], 0));
  });

  it('renders lead cards with avatar initials and badges', async () => {
    await setup();
    await loadList();

    const card = fixture.debugElement.query(By.css('.lead-card')).nativeElement;
    expect(card.textContent).toContain('Ava Smith');
    expect(card.textContent).toContain('AS');
    expect(card.textContent).toContain('New');
    const consentBadge = fixture.debugElement.query(
      By.css('.lead-card__side .badge'),
    ).nativeElement;
    expect(consentBadge.getAttribute('aria-label')).toBe('Contact consent: in');
  });

  it('badges quarantined leads on the card', async () => {
    await setup();
    await loadList([{ ...LEAD_A, quarantined: true }]);

    const card = fixture.debugElement.query(By.css('.lead-card')).nativeElement;
    const quarantineBadge = fixture.debugElement.query(
      By.css('.lead-card .badge--quarantine'),
    ).nativeElement;
    expect(card.textContent).toContain('Quarantine');
    expect(quarantineBadge.textContent).toContain('Quarantine');
  });

  describe('quarantine approve/discard (QA admin-console finding 6)', () => {
    /** Opens the quarantine tab and flushes its filtered list. */
    async function openQuarantineTab(
      leads: AdminLeadListItem[] = [{ ...LEAD_A, quarantined: true }],
    ): Promise<void> {
      await loadList([]);
      const tab = fixture.debugElement
        .queryAll(By.css('.leads-page__tab'))
        .find((t) => (t.nativeElement.textContent ?? '').trim() === 'Quarantine');
      expect(tab).toBeTruthy();
      tab!.nativeElement.click();
      fixture.detectChanges();
      httpMock
        .expectOne((r) => r.url.endsWith('/api/v1/admin/leads'))
        .flush(listResponse(leads, leads.length));
      await fixture.whenStable();
      fixture.detectChanges();
    }

    /** Polls until the quarantine card is gone (or the deadline hits). */
    async function waitForCardGone(): Promise<boolean> {
      const deadline = Date.now() + 5000;
      for (;;) {
        fixture.detectChanges();
        if (fixture.debugElement.query(By.css('.lead-card')) === null) {
          return true;
        }
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    it('shows approve and discard buttons to leads managers', async () => {
      await setup();
      await openQuarantineTab();
      const actions = fixture.debugElement.query(
        By.css('.lead-card__quarantine-actions'),
      );
      expect(actions).toBeTruthy();
      expect(actions.nativeElement.textContent).toContain('Approve');
      expect(actions.nativeElement.textContent).toContain('Discard');
    });

    it('hides the quarantine action buttons from viewers', async () => {
      await setup();
      store.reset({
        adminLeads: store.selectSnapshot((s) => s.adminLeads),
        adminBuilders: store.selectSnapshot((s) => s.adminBuilders),
        adminAuth: {
          ...store.selectSnapshot((s) => s.adminAuth),
          permissions: [],
        },
      });
      await openQuarantineTab();
      expect(
        fixture.debugElement.query(By.css('.lead-card__quarantine-actions')),
      ).toBeNull();
      // The quarantined row itself stays visible — read-only.
      expect(fixture.debugElement.query(By.css('.lead-card'))).toBeTruthy();
    });

    it('approve posts to the backend endpoint and removes the lead', async () => {
      await setup();
      await openQuarantineTab();

      fixture.debugElement
        .query(By.css('.lead-card__quarantine-approve'))
        .nativeElement.click();
      fixture.detectChanges();
      httpMock
        .expectOne(
          (r) =>
            r.url.endsWith('/api/v1/admin/leads/a1/quarantine/approve') &&
            r.method === 'POST',
        )
        .flush({});
      expect(await waitForCardGone()).toBe(true);
      expect(store.selectSnapshot(AdminLeadsState.leads).length).toBe(0);
    });

    it('discard needs a two-step confirm and posts to the discard endpoint', async () => {
      await setup();
      await openQuarantineTab();

      // First click arms the confirm; nothing is posted yet.
      fixture.debugElement
        .query(By.css('.lead-card__quarantine-discard'))
        .nativeElement.click();
      fixture.detectChanges();
      const confirm = fixture.debugElement.query(
        By.css('.lead-card__quarantine-confirm'),
      );
      expect(confirm).toBeTruthy();
      expect(confirm.nativeElement.textContent).toContain('Confirm discard');
      httpMock.expectNone(
        (r) =>
          r.url.endsWith('/api/v1/admin/leads/a1/quarantine/discard') &&
          r.method === 'POST',
      );

      // Confirm posts and removes the lead.
      confirm.nativeElement.click();
      fixture.detectChanges();
      httpMock
        .expectOne(
          (r) =>
            r.url.endsWith('/api/v1/admin/leads/a1/quarantine/discard') &&
            r.method === 'POST',
        )
        .flush({});
      expect(await waitForCardGone()).toBe(true);
      expect(store.selectSnapshot(AdminLeadsState.leads).length).toBe(0);
    });

    it('shows an inline error when the approve call fails', async () => {
      await setup();
      await openQuarantineTab();

      fixture.debugElement
        .query(By.css('.lead-card__quarantine-approve'))
        .nativeElement.click();
      fixture.detectChanges();
      httpMock
        .expectOne(
          (r) =>
            r.url.endsWith('/api/v1/admin/leads/a1/quarantine/approve') &&
            r.method === 'POST',
        )
        .flush('Forbidden', { status: 403, statusText: 'Forbidden' });
      await fixture.whenStable();
      fixture.detectChanges();
      const error = fixture.debugElement.query(
        By.css('.leads-page__quarantine-error'),
      );
      expect(error).toBeTruthy();
      // The lead stays in the list so the action can be retried.
      expect(fixture.debugElement.query(By.css('.lead-card'))).toBeTruthy();
    });
  });

  it('row click selects the lead and opens the modal', async () => {
    await setup();
    await loadList();

    fixture.debugElement.query(By.css('.lead-card')).nativeElement.click();
    fixture.detectChanges();
    expect(store.selectSnapshot(AdminLeadsState.selectedLeadId)).toBe('a1');

    // The detail fetch completes; the modal opens behind the list.
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET')
      .flush({
        ...LEAD_A,
        phone: '403-555-0100',
        marketingConsent: true,
        consentTs: '2026-09-20T10:00:00.000Z',
        magicLinkStatus: 'sent',
        sheetsSyncedAt: null,
        snapshotCount: 1,
        notes: [],
        statusHistory: [],
      });
    await fixture.whenStable();
    fixture.detectChanges();

    const modal = fixture.debugElement.query(
      By.css('app-admin-lead-detail .lead-modal-card'),
    );
    expect(modal).toBeTruthy();
    expect(modal.nativeElement.textContent).toContain('Ava Smith');
  });

  it('shows the designed empty state when there are no leads', async () => {
    await setup();
    await loadList([], 0);

    const empty = fixture.debugElement.query(By.css('.leads-page__empty'));
    expect(empty).toBeTruthy();
    expect(empty.nativeElement.textContent).toContain('No leads match these filters');
    expect(fixture.debugElement.query(By.css('.lead-card'))).toBeNull();
  });

  it('clearing all filters reloads the unfiltered list', async () => {
    await setup();
    await loadList();

    const clear = fixture.debugElement.query(By.css('.leads-page__clear')).nativeElement;
    clear.click();
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req.request.params.get('status')).toBeNull();
    expect(req.request.params.get('search')).toBeNull();
    req.flush(listResponse([LEAD_A], 1));
  });

  it('debounced search filters the list', async () => {
    await setup();
    await loadList();

    const input = fixture.debugElement.query(By.css('.leads-page__filter input'))
      .nativeElement as HTMLInputElement;
    input.value = 'ava';
    input.dispatchEvent(new Event('input'));
    // Search is debounced (250ms); wait past it in real time.
    await new Promise((resolve) => setTimeout(resolve, 350));
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req.request.params.get('search')).toBe('ava');
    req.flush(listResponse([LEAD_A], 1));
  });
});
