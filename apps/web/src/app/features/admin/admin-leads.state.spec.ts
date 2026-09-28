import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import {
  AddAdminLeadNote,
  DismissAdminLeadNoteError,
  DismissAdminLeadStatusError,
  DismissAdminLeadStatusSuccess,
  DismissExportError,
  ExportAdminLeadsCsv,
  LoadAdminLeads,
  LoadMoreAdminLeads,
  SelectAdminLead,
  SetAdminLeadsTab,
  ToggleAdminLeadsSandbox,
  UpdateAdminLeadStatus,
} from './admin-leads.actions';
import { AdminLeadsState } from './admin-leads.state';
import type { AdminLeadDetail, AdminLeadListItem } from '@feasly/contracts';

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
  discarded: false,
  createdAt: '2026-09-20T10:00:00.000Z',
  contactConsent: 'in',
  consentUpdatedAt: '2026-09-20T10:00:00.000Z',
};

const LEAD_B: AdminLeadListItem = {
  ...LEAD_A,
  id: 'b2',
  name: 'Ben Jones',
  email: 'ben@example.com',
  leadScore: 45,
  sandbox: true,
};

const DETAIL_A: AdminLeadDetail = {
  ...LEAD_A,
  phone: null,
  marketingConsent: true,
  consentTs: '2026-09-20T10:00:00.000Z',
  quarantined: false,
  unsubscribedAt: null,
  nudgeSentAt: null,
  estimate: {
    estimateId: 'e1',
    addressKey: LEAD_A.addressKey,
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

function listResponse(
  leads: AdminLeadListItem[],
  nextCursor: string | null,
  totalCount: number,
  statusCounts: Record<string, number> = {
    new: totalCount,
    contacted: 0,
    quoting: 0,
    won: 0,
    lost: 0,
  },
) {
  return { leads, nextCursor, totalCount, statusCounts };
}

/**
 * AdminLeadsState (admin/02): filters → backend params, cursor pagination,
 * detail drawer, notes, status, quarantine tab, sandbox toggle.
 */
describe('AdminLeadsState', () => {
  let store: Store;
  let httpMock: HttpTestingController;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
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
  }

  beforeEach(async () => {
    await setup();
  });

  it('loads the first page and stores filters', async () => {
    const done = store.dispatch(new LoadAdminLeads({ status: 'new', minScore: 50 }));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req.request.params.get('status')).toBe('new');
    expect(req.request.params.get('minScore')).toBe('50');
    // Quarantined rows stay hidden on the all-leads tab by default.
    expect(req.request.params.get('includeQuarantined')).toBeNull();
    req.flush(listResponse([LEAD_A], 'cursor-1', 1));
    await done.toPromise();

    expect(store.selectSnapshot(AdminLeadsState.leads)).toEqual([LEAD_A]);
    expect(store.selectSnapshot(AdminLeadsState.totalCount)).toBe(1);
    expect(store.selectSnapshot(AdminLeadsState.hasMore)).toBe(true);
    expect(store.selectSnapshot(AdminLeadsState.listStatus)).toBe('idle');
  });

  it('appends the next cursor page on LoadMore', async () => {
    let done = store.dispatch(new LoadAdminLeads());
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads')).flush(listResponse([LEAD_A], 'c1', 2));
    await done.toPromise();

    done = store.dispatch(new LoadMoreAdminLeads());
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req.request.params.get('cursor')).toBe('c1');
    req.flush(listResponse([LEAD_B], null, 2));
    await done.toPromise();

    expect(store.selectSnapshot(AdminLeadsState.leads)).toEqual([LEAD_A, LEAD_B]);
    expect(store.selectSnapshot(AdminLeadsState.hasMore)).toBe(false);
  });

  it('does not request another page when the cursor is null', async () => {
    const done = store.dispatch(new LoadAdminLeads());
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads')).flush(listResponse([LEAD_A], null, 1));
    await done.toPromise();

    store.dispatch(new LoadMoreAdminLeads());
    httpMock.expectNone((r) => r.url.endsWith('/api/v1/admin/leads'));
  });

  it('forces includeQuarantined on the quarantine tab', async () => {
    const done = store.dispatch(new SetAdminLeadsTab('quarantine'));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req.request.params.get('includeQuarantined')).toBe('true');
    req.flush(listResponse([], null, 0));
    await done.toPromise();
    expect(store.selectSnapshot(AdminLeadsState.tab)).toBe('quarantine');
  });

  it('passes includeSandbox only when toggled on', async () => {
    let done = store.dispatch(new ToggleAdminLeadsSandbox(true));
    let req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req.request.params.get('includeSandbox')).toBe('true');
    req.flush(listResponse([LEAD_B], null, 1));
    await done.toPromise();
    expect(store.selectSnapshot(AdminLeadsState.includeSandbox)).toBe(true);

    done = store.dispatch(new ToggleAdminLeadsSandbox(false));
    req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads'));
    expect(req.request.params.get('includeSandbox')).toBeNull();
    req.flush(listResponse([], null, 0));
    await done.toPromise();
  });

  it('loads detail on selection and surfaces errors', async () => {
    let done = store.dispatch(new SelectAdminLead('a1'));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1'));
    req.flush(DETAIL_A);
    await done.toPromise();
    expect(store.selectSnapshot(AdminLeadsState.detail)?.id).toBe('a1');
    expect(store.selectSnapshot(AdminLeadsState.detailStatus)).toBe('idle');

    done = store.dispatch(new SelectAdminLead('missing'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/missing'))
      .error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);
    expect(store.selectSnapshot(AdminLeadsState.detailStatus)).toBe('error');
    expect(store.selectSnapshot(AdminLeadsState.detailError)).toBeTruthy();
  });

  it('keeps the open detail on screen during a refresh instead of flashing', async () => {
    let done = store.dispatch(new SelectAdminLead('a1'));
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1')).flush(DETAIL_A);
    await done.toPromise();
    expect(store.selectSnapshot(AdminLeadsState.detail)?.id).toBe('a1');

    // Re-selecting the open lead is a refresh: the stale detail stays
    // visible while the refetch is in flight.
    done = store.dispatch(new SelectAdminLead('a1'));
    expect(store.selectSnapshot(AdminLeadsState.detail)?.id).toBe('a1');
    expect(store.selectSnapshot(AdminLeadsState.detailStatus)).toBe('loading');
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1'))
      .flush({ ...DETAIL_A, leadScore: 90 });
    await done.toPromise();
    expect(store.selectSnapshot(AdminLeadsState.detail)?.leadScore).toBe(90);
    expect(store.selectSnapshot(AdminLeadsState.detailStatus)).toBe('idle');
  });

  it('keeps the stale detail and surfaces an inline error when a refresh fails', async () => {
    let done = store.dispatch(new SelectAdminLead('a1'));
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1')).flush(DETAIL_A);
    await done.toPromise();

    done = store.dispatch(new SelectAdminLead('a1'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1'))
      .error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);

    // The modal is not wiped; the failure shows inline instead.
    expect(store.selectSnapshot(AdminLeadsState.detail)?.id).toBe('a1');
    expect(store.selectSnapshot(AdminLeadsState.detailStatus)).toBe('idle');
    expect(store.selectSnapshot(AdminLeadsState.detailRefreshError)).toBeTruthy();
  });

  it('sets statusUpdateSuccess on apply and clears it on dismiss', async () => {
    let done = store.dispatch(new SelectAdminLead('a1'));
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1')).flush(DETAIL_A);
    await done.toPromise();

    done = store.dispatch(new UpdateAdminLeadStatus('a1', 'contacted'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/status'))
      .flush({ ok: true });
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET')
      .flush({ ...DETAIL_A, status: 'contacted' });
    await done.toPromise();

    // The confirmation survives the post-apply refresh.
    expect(store.selectSnapshot(AdminLeadsState.statusUpdateSuccess)).toBe(true);

    store.dispatch(new DismissAdminLeadStatusSuccess());
    expect(store.selectSnapshot(AdminLeadsState.statusUpdateSuccess)).toBe(false);
  });

  it('surfaces the note-post error instead of failing silently', async () => {
    let done = store.dispatch(new SelectAdminLead('a1'));
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1')).flush(DETAIL_A);
    await done.toPromise();

    done = store.dispatch(new AddAdminLeadNote('a1', 'Hello?'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/notes'))
      .error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);

    expect(store.selectSnapshot(AdminLeadsState.notePosting)).toBe(false);
    expect(store.selectSnapshot(AdminLeadsState.noteError)).toBeTruthy();

    store.dispatch(new DismissAdminLeadNoteError());
    expect(store.selectSnapshot(AdminLeadsState.noteError)).toBeNull();
  });

  it('posts a note then refetches the detail', async () => {
    let done = store.dispatch(new SelectAdminLead('a1'));
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1')).flush(DETAIL_A);
    await done.toPromise();

    done = store.dispatch(new AddAdminLeadNote('a1', 'Called — wants premium.'));
    const noteReq = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/notes'));
    expect(noteReq.request.body).toEqual({ note: 'Called — wants premium.' });
    noteReq.flush({ ok: true });
    // Detail refetch follows the mutation (server is source of truth).
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET')
      .flush({ ...DETAIL_A, notes: [{ id: 'n1', note: 'Called — wants premium.', createdAt: '2026-09-25T10:00:00.000Z' }] });
    await done.toPromise();
    expect(store.selectSnapshot(AdminLeadsState.notePosting)).toBe(false);
    expect(store.selectSnapshot(AdminLeadsState.detail)?.notes).toHaveLength(1);
  });

  it('updates the row status locally and refetches detail', async () => {
    let done = store.dispatch(new LoadAdminLeads());
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads')).flush(listResponse([LEAD_A], null, 1));
    await done.toPromise();

    done = store.dispatch(new UpdateAdminLeadStatus('a1', 'won'));
    const statusReq = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/status'));
    expect(statusReq.request.body).toEqual({ status: 'won' });
    statusReq.flush({ ok: true });
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET')
      .flush({ ...DETAIL_A, status: 'won' });
    await done.toPromise();

    expect(store.selectSnapshot(AdminLeadsState.leads)[0]?.status).toBe('won');
    expect(store.selectSnapshot(AdminLeadsState.detail)?.status).toBe('won');
    expect(store.selectSnapshot(AdminLeadsState.statusUpdating)).toBe(false);
  });

  it('stores pipeline totals from the list response', async () => {
    const done = store.dispatch(new LoadAdminLeads());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads'))
      .flush(
        listResponse([LEAD_A], null, 3, {
          new: 1,
          contacted: 2,
          quoting: 0,
          won: 0,
          lost: 0,
        }),
      );
    await done.toPromise();

    expect(store.selectSnapshot(AdminLeadsState.statusCounts)).toEqual({
      new: 1,
      contacted: 2,
      quoting: 0,
      won: 0,
      lost: 0,
    });
  });

  it('applies the status change optimistically before the API responds', async () => {
    let done = store.dispatch(new LoadAdminLeads());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads'))
      .flush(listResponse([LEAD_A], null, 1, { new: 1, contacted: 0, quoting: 0, won: 0, lost: 0 }));
    await done.toPromise();

    done = store.dispatch(new SelectAdminLead('a1'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET')
      .flush(DETAIL_A);
    await done.toPromise();

    done = store.dispatch(new UpdateAdminLeadStatus('a1', 'contacted'));
    // Optimistic: row, modal badge, and totals move before the PATCH lands.
    expect(store.selectSnapshot(AdminLeadsState.leads)[0]?.status).toBe('contacted');
    expect(store.selectSnapshot(AdminLeadsState.detail)?.status).toBe('contacted');
    expect(store.selectSnapshot(AdminLeadsState.statusCounts)).toEqual({
      new: 0,
      contacted: 1,
      quoting: 0,
      won: 0,
      lost: 0,
    });
    expect(store.selectSnapshot(AdminLeadsState.statusUpdating)).toBe(true);

    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/status')).flush({ ok: true });
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET')
      .flush({ ...DETAIL_A, status: 'contacted' });
    await done.toPromise();

    expect(store.selectSnapshot(AdminLeadsState.statusUpdating)).toBe(false);
    expect(store.selectSnapshot(AdminLeadsState.statusUpdateError)).toBeNull();
  });

  it('rolls back the optimistic update and surfaces an error on failure', async () => {
    let done = store.dispatch(new LoadAdminLeads());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads'))
      .flush(listResponse([LEAD_A], null, 1, { new: 1, contacted: 0, quoting: 0, won: 0, lost: 0 }));
    await done.toPromise();

    done = store.dispatch(new SelectAdminLead('a1'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET')
      .flush(DETAIL_A);
    await done.toPromise();

    done = store.dispatch(new UpdateAdminLeadStatus('a1', 'won'));
    expect(store.selectSnapshot(AdminLeadsState.leads)[0]?.status).toBe('won');

    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/status'))
      .error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);

    // Rolled back everywhere, error surfaced for the modal's inline message.
    expect(store.selectSnapshot(AdminLeadsState.leads)[0]?.status).toBe('new');
    expect(store.selectSnapshot(AdminLeadsState.detail)?.status).toBe('new');
    expect(store.selectSnapshot(AdminLeadsState.statusCounts)).toEqual({
      new: 1,
      contacted: 0,
      quoting: 0,
      won: 0,
      lost: 0,
    });
    expect(store.selectSnapshot(AdminLeadsState.statusUpdating)).toBe(false);
    expect(store.selectSnapshot(AdminLeadsState.statusUpdateError)).toBeTruthy();
    // No detail refetch on failure — nothing changed server-side.
    httpMock.expectNone((r) => r.url.endsWith('/api/v1/admin/leads/a1') && r.method === 'GET');
  });

  it('dismisses the status error when the admin picks a new status', async () => {
    let done = store.dispatch(new LoadAdminLeads());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads'))
      .flush(listResponse([LEAD_A], null, 1));
    await done.toPromise();

    done = store.dispatch(new UpdateAdminLeadStatus('a1', 'won'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/a1/status'))
      .error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);
    expect(store.selectSnapshot(AdminLeadsState.statusUpdateError)).toBeTruthy();

    store.dispatch(new DismissAdminLeadStatusError());
    expect(store.selectSnapshot(AdminLeadsState.statusUpdateError)).toBeNull();
  });

  it('records list errors without crashing', async () => {
    const done = store.dispatch(new LoadAdminLeads());
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads')).error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);
    expect(store.selectSnapshot(AdminLeadsState.listStatus)).toBe('error');
    expect(store.selectSnapshot(AdminLeadsState.listError)).toBeTruthy();
  });

  it('exports the filtered set and triggers a download', async () => {
    // jsdom has no URL.createObjectURL — define it for this test only.
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    // Spy on a real anchor so jsdom's appendChild accepts it.
    const realCreateElement = document.createElement.bind(document);
    const click = vi.fn();
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const el = realCreateElement(tagName, options);
      if (tagName === 'a') {
        vi.spyOn(el as HTMLAnchorElement, 'click').mockImplementation(click);
      }
      return el;
    }) as typeof document.createElement);
    vi.useFakeTimers();

    const done = store.dispatch(new LoadAdminLeads({ source: 'web' }));
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads')).flush(listResponse([], null, 0));
    await done.toPromise();

    const exportDone = store.dispatch(new ExportAdminLeadsCsv());
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/leads/export.csv'));
    expect(req.request.params.get('source')).toBe('web');
    req.flush(new Blob(['a,b'], { type: 'text/csv' }));
    await exportDone.toPromise();

    expect(click).toHaveBeenCalled();
    // The object URL must NOT be revoked synchronously: revoking it in the
    // same task as the programmatic click aborts the download in
    // Safari/WebKit (2026-09-28: Export CSV silently did nothing on iPhone).
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    expect(store.selectSnapshot(AdminLeadsState.exporting)).toBe(false);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records export errors inline without crashing to the /error page', async () => {
    // Regression: the tap({ error }) handler did not swallow the ApiError, so
    // it propagated through the NGXS dispatch stream as an unhandled error
    // and the global handler routed the admin to /error (2026-09-27).
    const done = store.dispatch(new ExportAdminLeadsCsv());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/export.csv'))
      .error(new ProgressEvent('error'), { status: 500 });
    // Must RESOLVE (not reject): the error is swallowed into exportError state.
    await done.toPromise();
    expect(store.selectSnapshot(AdminLeadsState.exporting)).toBe(false);
    expect(store.selectSnapshot(AdminLeadsState.exportError)).toBeTruthy();
  });

  it('clears the export error on dismiss and on retry', async () => {
    const done = store.dispatch(new ExportAdminLeadsCsv());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/export.csv'))
      .error(new ProgressEvent('error'), { status: 500 });
    await done.toPromise();
    expect(store.selectSnapshot(AdminLeadsState.exportError)).toBeTruthy();

    store.dispatch(new DismissExportError());
    expect(store.selectSnapshot(AdminLeadsState.exportError)).toBeNull();

    // A retry clears the stale error before the request fires.
    const retry = store.dispatch(new ExportAdminLeadsCsv());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/leads/export.csv'))
      .error(new ProgressEvent('error'), { status: 500 });
    await retry.toPromise();
    expect(store.selectSnapshot(AdminLeadsState.exportError)).toBeTruthy();
  });
});
