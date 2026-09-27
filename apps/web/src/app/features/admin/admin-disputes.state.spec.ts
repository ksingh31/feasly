import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DisputeDetailResponse,
  DisputeEvidenceSnapshot,
  DisputeListItem,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import {
  AcceptAdminDispute,
  ClearSelectedAdminDispute,
  DismissAdminDisputeResolution,
  LoadAdminDisputes,
  RejectAdminDispute,
  SelectAdminDispute,
} from './admin-disputes.actions';
import { AdminDisputesState } from './admin-disputes.state';

const SNAPSHOT: DisputeEvidenceSnapshot = {
  invoiceId: 'inv-1',
  tenantKey: 'elite-craft',
  attributionId: 'attr-1',
  leadId: 'lead-1',
  contractValueCents: 1000000,
  commissionCents: 10000,
  currency: 'CAD',
  stripePaymentIntentId: null,
  status: 'disputed',
  reviewDueAt: null,
  disputeReason: 'Contract value reported twice',
  invoiceCreatedAt: '2026-09-20T10:00:00.000Z',
  disputedAt: '2026-09-25T12:00:00.000Z',
};

const DISPUTE_A: DisputeListItem = {
  id: 'd1',
  invoiceId: 'inv-1',
  tenantKey: 'elite-craft',
  reason: 'Contract value reported twice',
  status: 'open',
  openedAt: '2026-09-25T12:00:00.000Z',
  slaDueAt: '2026-10-02T12:00:00.000Z',
  slaBreachedAt: null,
  commissionCents: 10000,
  currency: 'CAD',
  contractValueCents: 1000000,
  businessDaysRemaining: 4,
  breached: false,
};

const DISPUTE_B: DisputeListItem = {
  ...DISPUTE_A,
  id: 'd2',
  reason: 'Prior relationship exclusion',
  businessDaysRemaining: -1,
  breached: true,
  slaBreachedAt: '2026-10-03T12:00:00.000Z',
};

const DETAIL_A: DisputeDetailResponse = {
  ...DISPUTE_A,
  evidenceSnapshot: SNAPSHOT,
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  auditTrail: [
    {
      id: 'ev-1',
      tenantKey: 'elite-craft',
      eventType: 'dispute.opened',
      entityType: 'billing_dispute',
      entityId: 'd1',
      payload: null,
      createdAt: '2026-09-25T12:00:00.000Z',
    },
  ],
};

/**
 * AdminDisputesState (billing/01 follow-on, was OPS-009): open-disputes
 * list oldest-first, detail with immutable evidence snapshot + audit trail,
 * and accept/reject resolution.
 */
describe('AdminDisputesState', () => {
  let store: Store;
  let httpMock: HttpTestingController;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ConfigService,
        provideStore([AdminDisputesState]),
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

  it('loads the open disputes and stores them oldest first', async () => {
    const done = store.dispatch(new LoadAdminDisputes());
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/disputes'));
    expect(req.request.method).toBe('GET');
    req.flush({ disputes: [DISPUTE_A, DISPUTE_B] });
    await done.toPromise();

    expect(store.selectSnapshot(AdminDisputesState.disputes)).toEqual([DISPUTE_A, DISPUTE_B]);
    expect(store.selectSnapshot(AdminDisputesState.listStatus)).toBe('idle');
    expect(store.selectSnapshot(AdminDisputesState.listError)).toBeNull();
  });

  it('surfaces a load failure', async () => {
    const done = store.dispatch(new LoadAdminDisputes());
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/disputes')).error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);

    expect(store.selectSnapshot(AdminDisputesState.listStatus)).toBe('error');
    expect(store.selectSnapshot(AdminDisputesState.listError)).not.toBeNull();
  });

  it('selects a dispute and loads the immutable evidence snapshot + audit trail', async () => {
    const done = store.dispatch(new SelectAdminDispute('d1'));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/disputes/d1'));
    req.flush(DETAIL_A);
    await done.toPromise();

    expect(store.selectSnapshot(AdminDisputesState.selectedDisputeId)).toBe('d1');
    const detail = store.selectSnapshot(AdminDisputesState.detail);
    expect(detail?.evidenceSnapshot).toEqual(SNAPSHOT);
    // The snapshot is immutable: it is the invoice state at dispute-open
    // time, rendered instead of the live invoice row.
    expect(detail?.evidenceSnapshot.status).toBe('disputed');
    expect(detail?.auditTrail).toHaveLength(1);
    expect(store.selectSnapshot(AdminDisputesState.detailStatus)).toBe('idle');
  });

  it('selecting another dispute after one loads shows the new detail', async () => {
    // NGXS dispatches are sequential: a second select only runs after the
    // first completes, so the detail always matches the latest selection.
    let done = store.dispatch(new SelectAdminDispute('d1'));
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/disputes/d1')).flush(DETAIL_A);
    await done.toPromise();

    const DETAIL_B: DisputeDetailResponse = { ...DETAIL_A, id: 'd2', evidenceSnapshot: { ...SNAPSHOT, invoiceId: 'inv-2' } };
    done = store.dispatch(new SelectAdminDispute('d2'));
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/disputes/d2')).flush(DETAIL_B);
    await done.toPromise();

    expect(store.selectSnapshot(AdminDisputesState.selectedDisputeId)).toBe('d2');
    expect(store.selectSnapshot(AdminDisputesState.detail)?.id).toBe('d2');
    expect(store.selectSnapshot(AdminDisputesState.detail)?.evidenceSnapshot.invoiceId).toBe('inv-2');
  });

  it('accepts a dispute with a note: it leaves the open list and the banner shows', async () => {
    const load = store.dispatch(new LoadAdminDisputes());
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/disputes')).flush({ disputes: [DISPUTE_A] });
    await load.toPromise();

    const done = store.dispatch(new AcceptAdminDispute('d1', 'valid credit'));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/disputes/d1/accept'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ note: 'valid credit' });
    req.flush({ ...DISPUTE_A, status: 'accepted' });
    await done.toPromise();

    expect(store.selectSnapshot(AdminDisputesState.disputes)).toEqual([]);
    expect(store.selectSnapshot(AdminDisputesState.selectedDisputeId)).toBeNull();
    expect(store.selectSnapshot(AdminDisputesState.resolving)).toBe(false);
    expect(store.selectSnapshot(AdminDisputesState.lastResolution)).toEqual({
      disputeId: 'd1',
      outcome: 'accepted',
    });
  });

  it('rejects a dispute without a note: empty note is omitted from the body', async () => {
    const done = store.dispatch(new RejectAdminDispute('d2'));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/disputes/d2/reject'));
    expect(req.request.body).toEqual({});
    req.flush({ ...DISPUTE_B, status: 'rejected' });
    await done.toPromise();

    expect(store.selectSnapshot(AdminDisputesState.lastResolution)).toEqual({
      disputeId: 'd2',
      outcome: 'rejected',
    });
  });

  it('surfaces a resolve failure and keeps the dispute in the list', async () => {
    const load = store.dispatch(new LoadAdminDisputes());
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/disputes')).flush({ disputes: [DISPUTE_A] });
    await load.toPromise();

    const done = store.dispatch(new AcceptAdminDispute('d1'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/disputes/d1/accept'))
      .error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);

    expect(store.selectSnapshot(AdminDisputesState.resolving)).toBe(false);
    expect(store.selectSnapshot(AdminDisputesState.resolveError)).not.toBeNull();
    expect(store.selectSnapshot(AdminDisputesState.disputes)).toEqual([DISPUTE_A]);
    expect(store.selectSnapshot(AdminDisputesState.lastResolution)).toBeNull();
  });

  it('marks resolving while a resolve is in flight and clears it after', async () => {
    const done = store.dispatch(new AcceptAdminDispute('d1'));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/disputes/d1/accept'));
    // The flag drives the UI (buttons disabled) while the request is open.
    expect(store.selectSnapshot(AdminDisputesState.resolving)).toBe(true);
    req.flush({ ...DISPUTE_A, status: 'accepted' });
    await done.toPromise();
    expect(store.selectSnapshot(AdminDisputesState.resolving)).toBe(false);
    expect(store.selectSnapshot(AdminDisputesState.lastResolution)?.outcome).toBe('accepted');
  });

  it('dismisses the resolution banner', async () => {
    const done = store.dispatch(new AcceptAdminDispute('d1'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/disputes/d1/accept'))
      .flush({ ...DISPUTE_A, status: 'accepted' });
    await done.toPromise();
    expect(store.selectSnapshot(AdminDisputesState.lastResolution)).not.toBeNull();

    store.dispatch(new DismissAdminDisputeResolution());
    expect(store.selectSnapshot(AdminDisputesState.lastResolution)).toBeNull();
  });

  it('clears the selection', () => {
    store.dispatch(new SelectAdminDispute('d1'));
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/disputes/d1'));
    store.dispatch(new ClearSelectedAdminDispute());
    expect(store.selectSnapshot(AdminDisputesState.selectedDisputeId)).toBeNull();
    expect(store.selectSnapshot(AdminDisputesState.detail)).toBeNull();
  });

  it('exposes the selectSignal-style selectors as functions', () => {
    // Static selectors must all be callable without a store instance —
    // the component binds them via store.selectSignal(...).
    for (const selector of [
      AdminDisputesState.disputes,
      AdminDisputesState.listStatus,
      AdminDisputesState.listError,
      AdminDisputesState.selectedDisputeId,
      AdminDisputesState.detail,
      AdminDisputesState.detailStatus,
      AdminDisputesState.detailError,
      AdminDisputesState.resolving,
      AdminDisputesState.resolveError,
      AdminDisputesState.lastResolution,
    ]) {
      expect(vi.isMockFunction(selector) || typeof selector === 'function').toBe(true);
    }
  });
});
