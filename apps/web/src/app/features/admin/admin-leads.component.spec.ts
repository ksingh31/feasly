import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminLeadListItem } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { UiConfirmService, UiDrawerService } from '@app/shared/ui';
import { AdminLeadsComponent } from './admin-leads.component';
import { AdminLeadsState } from './admin-leads.state';
import { AdminBuildersState } from './admin-builders.state';
import { AdminAuthState } from './admin-auth.state';
import { ADMIN_PERMISSIONS } from './admin-permissions';
import { AdminLeadDrawerComponent } from './admin-lead-drawer.component';

const LEAD_A: AdminLeadListItem = {
  id: 'a1',
  name: 'Ava Smith',
  email: 'ava@example.com',
  addressKey: '123 Main St NW, Calgary, AB',
  leadScore: 82,
  status: 'new',
  source: 'mcp',
  projectType: 'new_build',
  tenantKey: 'elite-craft',
  timeline: '6-12 months',
  sandbox: false,
  quarantined: false,
  discarded: false,
  createdAt: '2026-09-20T10:00:00.000Z',
  contactConsent: 'out',
  consentUpdatedAt: '2026-09-20T10:00:00.000Z',
};

const COUNTS = { new: 4, contacted: 3, quoting: 2, won: 1, lost: 0 };

function listResponse(leads: AdminLeadListItem[], totalCount = leads.length) {
  return { leads, nextCursor: null, totalCount, statusCounts: COUNTS };
}

/** Poll (with a deadline) for an async UI state — never a fixed sleep. */
async function until(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * #539 — Admin Leads: saved views, kit DataTable, drawer via `?open=`.
 */
describe('AdminLeadsComponent', () => {
  let store: Store;
  let http: HttpTestingController;
  let router: Router;
  let fixture: ComponentFixture<AdminLeadsComponent>;
  let openSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => vi.restoreAllMocks());

  async function setup(permissions: string[] = [ADMIN_PERMISSIONS.leadsManage]): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AdminLeadsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideLocationMocks(),
        ConfigService,
        provideStore([AdminLeadsState, AdminBuildersState, AdminAuthState]),
      ],
    });
    const config = TestBed.inject(ConfigService);
    http = TestBed.inject(HttpTestingController);
    const pending = config.load();
    http.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi: false } });
    await pending;
    store = TestBed.inject(Store);
    router = TestBed.inject(Router);
    store.reset({
      ...store.snapshot(),
      adminAuth: { ...store.selectSnapshot((s) => s.adminAuth), permissions },
    });
    // The drawer itself is covered by admin-lead-drawer.component.spec.ts.
    openSpy = vi.spyOn(TestBed.inject(UiDrawerService), 'open').mockReturnValue(null as never);
    fixture = TestBed.createComponent(AdminLeadsComponent);
  }

  function listRequests(): TestRequest[] {
    return http.match((r) => r.url.endsWith('/api/v1/admin/leads'));
  }

  /** Polls for list requests (accumulating — `match` consumes them) and flushes them. */
  async function nextListRequest(leads: AdminLeadListItem[] = [LEAD_A]): Promise<TestRequest> {
    const reqs: TestRequest[] = [];
    await until(() => {
      fixture.detectChanges();
      reqs.push(...listRequests());
      return reqs.length > 0;
    }, 'list request');
    reqs.forEach((r) => r.flush(listResponse(leads)));
    await fixture.whenStable();
    fixture.detectChanges();
    return reqs[reqs.length - 1];
  }

  /** Renders, flushes the first list load + builders. */
  async function load(leads: AdminLeadListItem[] = [LEAD_A]): Promise<TestRequest> {
    fixture.detectChanges();
    const req = await nextListRequest(leads);
    http
      .match((r) => r.url.endsWith('/api/v1/admin/builders'))
      .forEach((r) => r.flush({ builders: [{ id: 'b-1', displayName: 'Elite Craft' }] }));
    await fixture.whenStable();
    fixture.detectChanges();
    return req;
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function segment(label: string): HTMLButtonElement {
    const buttons = fixture.debugElement
      .queryAll(By.css('.leads-page__segment'))
      .map((d) => d.nativeElement as HTMLButtonElement);
    const hit = buttons.find((b) => b.textContent?.trim() === label);
    if (!hit) throw new Error(`no segment ${label}: ${buttons.map((b) => b.textContent).join('|')}`);
    return hit;
  }

  it('renders the leads in the kit DataTable with labelled columns and enum labels', async () => {
    await setup();
    await load();

    const headers = fixture.debugElement
      .queryAll(By.css('.ui-dt__table th'))
      .map((th) => (th.nativeElement as HTMLElement).textContent?.trim());
    expect(headers).toEqual(
      expect.arrayContaining(['Lead', 'Address', 'Status', 'Tenant', 'Source', 'Score', 'Timeline', 'Contact consent', 'Created']),
    );
    const row = fixture.debugElement.query(By.css('.ui-dt__row')).nativeElement as HTMLElement;
    expect(row.textContent).toContain('Ava Smith');
    expect(row.textContent).toContain('ava@example.com');
    expect(row.textContent).toContain('MCP');
    expect(row.textContent).toContain('Out');
    expect(row.textContent).not.toContain('mcp');
    expect(text()).toContain('1 lead');
  });

  it('shows the saved views New, Unassigned and Quoting > 7 days', async () => {
    await setup();
    await load();
    const labels = fixture.debugElement
      .queryAll(By.css('.leads-page__segment'))
      .map((d) => (d.nativeElement as HTMLElement).textContent?.trim());
    expect(labels).toEqual(['All', 'New', 'Unassigned', 'Quoting > 7 days']);
    expect(segment('All').getAttribute('aria-pressed')).toBe('true');
  });

  it('Unassigned view writes ?view= and loads builderId=unassigned', async () => {
    await setup();
    await load();

    segment('Unassigned').click();
    const req = await nextListRequest();
    expect(router.url).toContain('view=unassigned');
    expect(req.request.params.get('builderId')).toBe('unassigned');
    expect(segment('Unassigned').getAttribute('aria-pressed')).toBe('true');
    expect(text()).toContain('Leads not assigned to a builder.');
  });

  it('New view filters status=new', async () => {
    await setup();
    await load();
    segment('New').click();
    const req = await nextListRequest();
    expect(req.request.params.get('status')).toBe('new');
  });

  it('Quoting > 7 days view filters quoting leads created over 7 days ago', async () => {
    await setup();
    await load();
    const before = Date.now();
    segment('Quoting > 7 days').click();
    const req = await nextListRequest();
    expect(req.request.params.get('status')).toBe('quoting');
    const cutoff = Date.parse(req.request.params.get('createdBefore') ?? '');
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(cutoff).toBeLessThanOrEqual(before - sevenDays + 1000);
    expect(cutoff).toBeGreaterThan(before - sevenDays - 60_000);
  });

  it('a view deep link loads that view on first render', async () => {
    await setup();
    await router.navigateByUrl('/?view=new');
    const req = await load();
    expect(req.request.params.get('status')).toBe('new');
  });

  it('pipeline total tiles filter by status and show counts', async () => {
    await setup();
    await load();
    const tiles = fixture.debugElement.queryAll(By.css('.leads-page__total'));
    expect(tiles.map((t) => (t.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '4New',
      '3Contacted',
      '2Quoting',
      '1Won',
      '0Lost',
    ]);
    (tiles[2].nativeElement as HTMLButtonElement).click();
    const req = await nextListRequest();
    expect(req.request.params.get('status')).toBe('quoting');
    expect(router.url).toContain('status=quoting');
  });

  it('row click opens the lead drawer with ?open=<id>', async () => {
    await setup();
    await load();
    (fixture.debugElement.query(By.css('.ui-dt__row')).nativeElement as HTMLElement).click();
    expect(openSpy).toHaveBeenCalledWith(
      AdminLeadDrawerComponent,
      expect.objectContaining({ data: { id: 'a1' }, urlId: 'a1' }),
    );
  });

  it('a ?open= deep link opens the drawer without reloading the list on open', async () => {
    await setup();
    await router.navigateByUrl('/?open=a1');
    await load();
    expect(openSpy).toHaveBeenCalledWith(AdminLeadDrawerComponent, expect.objectContaining({ urlId: 'a1' }));
    // Only the drawer param changed: no second list load.
    await router.navigateByUrl('/?open=a2');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(listRequests()).toHaveLength(0);
  });

  it('shows the no-results state when a view matches nothing', async () => {
    await setup();
    await load();
    segment('New').click();
    await nextListRequest([]);
    expect(text()).toContain('No leads match');
  });

  describe('quarantine tab', () => {
    async function openQuarantine(): Promise<void> {
      const tab = fixture.debugElement.queryAll(By.css('.leads-page__tab'))[1].nativeElement as HTMLButtonElement;
      tab.click();
      fixture.detectChanges();
      const req = await nextListRequest([{ ...LEAD_A, quarantined: true }]);
      expect(req.request.params.get('quarantinedOnly')).toBe('true');
    }

    it('managers get Approve/Discard row actions; approve posts', async () => {
      await setup();
      await load();
      await openQuarantine();
      const approve = fixture.debugElement
        .queryAll(By.css('.leads-page__row-actions button'))
        .map((d) => d.nativeElement as HTMLButtonElement)
        .find((b) => b.textContent?.includes('Approve'));
      expect(approve).toBeTruthy();
      approve!.click();
      http
        .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/quarantine/approve') && r.method === 'POST')
        .flush({});
      await until(() => store.selectSnapshot(AdminLeadsState.leads).length === 0, 'lead removed');
    });

    it('discard asks first, then posts', async () => {
      await setup();
      await load();
      const confirm = vi.spyOn(TestBed.inject(UiConfirmService), 'confirm').mockReturnValue(of(true));
      await openQuarantine();
      const discard = fixture.debugElement
        .queryAll(By.css('.leads-page__row-actions button'))
        .map((d) => d.nativeElement as HTMLButtonElement)
        .find((b) => b.textContent?.includes('Discard'));
      discard!.click();
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Discard Ava Smith?', tone: 'danger' }));
      http
        .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/quarantine/discard') && r.method === 'POST')
        .flush({});
      await until(() => store.selectSnapshot(AdminLeadsState.leads).length === 0, 'lead removed');
    });

    it('viewers see no row actions', async () => {
      await setup([]);
      await load();
      await openQuarantine();
      expect(fixture.debugElement.query(By.css('.leads-page__row-actions'))).toBeNull();
    });
  });
});
