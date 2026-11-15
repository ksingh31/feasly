import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminLeadListItem } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { UiConfirmService, UiDrawerService, UiToastService } from '@app/shared/ui';
import { AdminQuarantineComponent } from './admin-quarantine.component';
import { AdminQuarantineState } from './admin-quarantine.state';
import { AdminLeadsState } from './admin-leads.state';
import { AdminAuthState } from './admin-auth.state';
import { ADMIN_PERMISSIONS } from './admin-permissions';

function lead(id: string, name: string): AdminLeadListItem {
  return {
    id,
    name,
    email: `${id}@example.com`,
    addressKey: '123 Main St NW, Calgary, AB',
    leadScore: 5,
    status: 'new',
    source: 'mcp',
    projectType: 'new_build',
    tenantKey: 'feasly',
    timeline: '6-12 months',
    sandbox: false,
    quarantined: true,
    discarded: false,
    createdAt: '2026-11-10T10:00:00.000Z',
    contactConsent: 'in',
    consentUpdatedAt: '2026-11-10T10:00:00.000Z',
  };
}

const A = lead('a1', 'Ava Smith');
const B = lead('b2', 'Ben Lee');
const COUNTS = { new: 0, contacted: 0, quoting: 0, won: 0, lost: 0 };

/** Poll (with a deadline) for an async UI state — never a fixed sleep. */
async function until(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** #540 — Admin Quarantine page: own route, row + bulk decisions with confirms. */
describe('AdminQuarantineComponent', () => {
  let store: Store;
  let http: HttpTestingController;
  let fixture: ComponentFixture<AdminQuarantineComponent>;
  let confirm: ReturnType<typeof vi.spyOn>;
  let toast: ReturnType<typeof vi.spyOn>;

  afterEach(() => vi.restoreAllMocks());

  async function setup(
    permissions: string[] = [ADMIN_PERMISSIONS.leadsManage],
    answer = true,
    leads: AdminLeadListItem[] = [A, B],
  ): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AdminQuarantineComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideLocationMocks(),
        ConfigService,
        provideStore([AdminQuarantineState, AdminLeadsState, AdminAuthState]),
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
    vi.spyOn(TestBed.inject(UiDrawerService), 'open').mockReturnValue(null as never);
    confirm = vi.spyOn(TestBed.inject(UiConfirmService), 'confirm').mockReturnValue(of(answer));
    toast = vi.spyOn(TestBed.inject(UiToastService), 'show').mockReturnValue(null as never);
    fixture = TestBed.createComponent(AdminQuarantineComponent);

    const reqs: TestRequest[] = [];
    await until(() => {
      fixture.detectChanges();
      reqs.push(...http.match((r) => r.url.endsWith('/api/v1/admin/leads')));
      return reqs.length > 0;
    }, 'list request');
    expect(reqs[0].request.params.get('quarantinedOnly')).toBe('true');
    reqs.forEach((r) => r.flush({ leads, totalCount: leads.length, nextCursor: null, statusCounts: COUNTS }));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const text = (): string => el().textContent ?? '';
  const buttons = (sel: string): HTMLButtonElement[] =>
    fixture.debugElement.queryAll(By.css(sel)).map((d) => d.nativeElement as HTMLButtonElement);
  const button = (sel: string, label: string): HTMLButtonElement => {
    const found = buttons(sel).find((b) => b.textContent?.includes(label));
    if (!found) throw new Error(`no ${label} button in ${sel}`);
    return found;
  };
  const rowCheckboxes = (): HTMLInputElement[] =>
    Array.from(el().querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]'));
  const leadsLeft = (): string[] => store.selectSnapshot(AdminQuarantineState.leads).map((l) => l.id);

  async function selectRows(count: number): Promise<void> {
    rowCheckboxes()
      .slice(0, count)
      .forEach((box) => {
        box.checked = true;
        box.dispatchEvent(new Event('change'));
      });
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('renders the queue with the explainer and count', async () => {
    await setup();
    expect(text()).toContain('Quarantine');
    expect(text()).toContain('Honeypot-flagged submissions land here');
    expect(text()).toContain('2 quarantined leads');
    expect(text()).toContain('Ava Smith');
  });

  it('row Approve posts straight away and toasts', async () => {
    await setup();
    button('.quarantine-page__row-actions button', 'Approve').click();
    expect(confirm).not.toHaveBeenCalled();
    http.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/quarantine/approve') && r.method === 'POST').flush({});
    await until(() => !leadsLeft().includes('a1'), 'a1 removed');
    await until(() => toast.mock.calls.length > 0, 'toast');
    expect(toast).toHaveBeenCalledWith({ message: 'Lead approved — back in the pipeline.' });
  });

  it('row Discard… confirms (danger) before posting', async () => {
    await setup();
    button('.quarantine-page__row-actions button', 'Discard').click();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Discard Ava Smith?', tone: 'danger', verb: 'Discard' }),
    );
    http.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/quarantine/discard') && r.method === 'POST').flush({});
    await until(() => !leadsLeft().includes('a1'), 'a1 removed');
  });

  it('a cancelled discard posts nothing', async () => {
    await setup(undefined, false);
    button('.quarantine-page__row-actions button', 'Discard').click();
    http.expectNone((r) => r.url.includes('/quarantine/'));
    expect(leadsLeft()).toEqual(['a1', 'b2']);
  });

  it('bulk bar appears on selection; Approve selected confirms then approves each lead', async () => {
    await setup();
    expect(el().querySelector('.quarantine-page__bulk')).toBeNull();
    await selectRows(2);
    expect(text()).toContain('2 selected');
    button('.quarantine-page__bulk button', 'Approve selected').click();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Approve 2 leads?', tone: 'default', verb: 'Approve' }),
    );
    http.expectOne((r) => r.url.endsWith('/a1/quarantine/approve')).flush({});
    http.expectOne((r) => r.url.endsWith('/b2/quarantine/approve')).flush({});
    await until(() => leadsLeft().length === 0, 'queue emptied');
    await until(() => toast.mock.calls.length > 0, 'toast');
    expect(toast).toHaveBeenCalledWith({ message: '2 leads approved — back in the pipeline.' });
    fixture.detectChanges();
    expect(el().querySelector('.quarantine-page__bulk')).toBeNull();
  });

  it('Discard selected confirms as danger; failures stay selected with an inline error', async () => {
    await setup();
    await selectRows(2);
    button('.quarantine-page__bulk button', 'Discard selected').click();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Discard 2 leads?', tone: 'danger' }));
    http.expectOne((r) => r.url.endsWith('/a1/quarantine/discard')).flush({});
    http
      .expectOne((r) => r.url.endsWith('/b2/quarantine/discard'))
      .flush('Unprocessable', { status: 422, statusText: 'Unprocessable' });
    await until(() => leadsLeft().length === 1, 'one left');
    fixture.detectChanges();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('1 of 2 leads could not be updated');
    expect(text()).toContain('1 selected');
    expect(toast).toHaveBeenCalledWith({ message: 'Lead discarded.' });
  });

  it('a cancelled bulk confirm keeps the selection and posts nothing', async () => {
    await setup(undefined, false);
    await selectRows(2);
    button('.quarantine-page__bulk button', 'Discard selected').click();
    http.expectNone((r) => r.url.includes('/quarantine/'));
    fixture.detectChanges();
    expect(text()).toContain('2 selected');
  });

  it('viewers without leads:manage get no checkboxes and no row actions', async () => {
    await setup([]);
    expect(rowCheckboxes()).toHaveLength(0);
    expect(el().querySelector('.quarantine-page__row-actions')).toBeNull();
  });

  it('shows the all-clear empty state when the queue is empty', async () => {
    await setup(undefined, true, []);
    expect(text()).toContain('Quarantine is clear');
  });
});
