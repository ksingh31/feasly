import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import type { BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import {
  ClearAdminInvoiceDetail,
  DismissAdminInvoiceDetailError,
  DismissAdminInvoiceListError,
  LoadAdminInvoiceDetail,
  LoadAdminInvoices,
  SetAdminInvoiceFilters,
} from './admin-invoices.actions';
import {
  AdminInvoicesState,
  type AdminInvoicesStateModel,
} from './admin-invoices.state';

const INVOICE_A: BuilderCommissionInvoice = {
  id: 'inv-1',
  tenantKey: 'elite-craft',
  attributionId: 'attr-1',
  leadId: 'lead-1',
  leadName: 'Ava Smith',
  contractValueCents: 1_000_000,
  commissionCents: 10_000,
  currency: 'CAD',
  stripePaymentIntentId: null,
  status: 'paid',
  reviewDueAt: null,
  finalizedAt: '2026-09-27T12:00:00.000Z',
  paidAt: '2026-09-28T12:00:00.000Z',
  slaBreached: false,
  disputeReason: null,
  commissionRateOverride: null,
  commissionRatePercent: 1,
  effectiveRatePercent: 1,
  manualPaymentMethod: null,
  paymentReference: null,
  invoiceNumber: 'INV-0042',
  paymentMethod: 'card',
  createdAt: '2026-09-20T12:00:00.000Z',
  updatedAt: '2026-09-28T12:00:00.000Z',
};

const INVOICE_B: BuilderCommissionInvoice = {
  ...INVOICE_A,
  id: 'inv-2',
  invoiceNumber: 'INV-0043',
  status: 'failed',
  paidAt: null,
};

/**
 * AdminInvoicesState (QA admin-console fix 3): the admin invoice list
 * (status + invoice-number filters, pagination) and the standalone detail.
 * Reuses BuilderInvoicesApiService — the admin session is accepted by the
 * backend's adminGuard fallback on /billing/invoices.
 */
describe('AdminInvoicesState', () => {
  let store: Store;
  let httpMock: HttpTestingController;

  function snapshot(): AdminInvoicesStateModel {
    return store.selectSnapshot<AdminInvoicesStateModel>(
      (state) => state.adminInvoices,
    );
  }

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ConfigService,
        provideStore([AdminInvoicesState]),
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

  it('loads the first page with default pagination and no filters', async () => {
    await setup();
    const done = store.dispatch(new LoadAdminInvoices());
    const req = httpMock.expectOne(
      (r) => r.url.endsWith('/api/v1/billing/invoices') && r.method === 'GET',
    );
    expect(req.request.params.get('limit')).toBe('20');
    expect(req.request.params.get('offset')).toBe('0');
    expect(req.request.params.has('status')).toBe(false);
    expect(req.request.params.has('invoiceNumber')).toBe(false);
    req.flush([INVOICE_A, INVOICE_B]);
    await done.toPromise();

    const s = snapshot();
    expect(s.listStatus).toBe('ready');
    expect(s.invoices.length).toBe(2);
    expect(s.invoices[0].invoiceNumber).toBe('INV-0042');
    expect(s.page).toBe(1);
    expect(s.pageSize).toBe(20);
  });

  it('sends the status and invoice-number filters to the backend', async () => {
    await setup();
    const done = store.dispatch(
      new SetAdminInvoiceFilters({ status: 'failed', invoiceNumber: '43' }),
    );
    const req = httpMock.expectOne(
      (r) => r.url.endsWith('/api/v1/billing/invoices') && r.method === 'GET',
    );
    expect(req.request.params.get('status')).toBe('failed');
    expect(req.request.params.get('invoiceNumber')).toBe('43');
    // Filters reset to page 1.
    expect(req.request.params.get('offset')).toBe('0');
    req.flush([INVOICE_B]);
    await done.toPromise();

    const s = snapshot();
    expect(s.filters).toEqual({ status: 'failed', invoiceNumber: '43' });
    expect(s.page).toBe(1);
    expect(s.invoices.length).toBe(1);
  });

  it('paginates with limit/offset and keeps the filters', async () => {
    await setup();
    const done = store.dispatch(
      new LoadAdminInvoices(2, 20, { status: 'paid', invoiceNumber: null }),
    );
    const req = httpMock.expectOne(
      (r) => r.url.endsWith('/api/v1/billing/invoices') && r.method === 'GET',
    );
    expect(req.request.params.get('limit')).toBe('20');
    expect(req.request.params.get('offset')).toBe('20');
    expect(req.request.params.get('status')).toBe('paid');
    req.flush([]);
    await done.toPromise();

    expect(snapshot().page).toBe(2);
    expect(snapshot().invoices).toEqual([]);
  });

  it('stores an inline list error when the load fails', async () => {
    await setup();
    const done = store.dispatch(new LoadAdminInvoices());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/invoices'))
      .flush('boom', { status: 500, statusText: 'Server Error' });
    await done.toPromise();

    const s = snapshot();
    expect(s.listStatus).toBe('error');
    expect(s.listError).toBeTruthy();
    expect(s.invoices).toEqual([]);
  });

  it('dismisses the list error', async () => {
    await setup();
    const done = store.dispatch(new LoadAdminInvoices());
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/invoices'))
      .flush('boom', { status: 500, statusText: 'Server Error' });
    await done.toPromise();
    expect(snapshot().listError).toBeTruthy();

    store.dispatch(new DismissAdminInvoiceListError());
    expect(snapshot().listError).toBeNull();
  });

  it('loads the invoice detail by id', async () => {
    await setup();
    const done = store.dispatch(new LoadAdminInvoiceDetail('inv-1'));
    httpMock
      .expectOne(
        (r) => r.url.endsWith('/api/v1/billing/invoices/inv-1') && r.method === 'GET',
      )
      .flush(INVOICE_A);
    await done.toPromise();

    const s = snapshot();
    expect(s.detailStatus).toBe('ready');
    expect(s.detail?.invoiceNumber).toBe('INV-0042');
    expect(s.detail?.status).toBe('paid');
  });

  it('stores an inline detail error when the detail load fails', async () => {
    await setup();
    const done = store.dispatch(new LoadAdminInvoiceDetail('missing'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/invoices/missing'))
      .flush('not found', { status: 404, statusText: 'Not Found' });
    await done.toPromise();

    const s = snapshot();
    expect(s.detailStatus).toBe('error');
    expect(s.detailError).toBeTruthy();
    expect(s.detail).toBeNull();
  });

  it('dismisses the detail error and clears the detail', async () => {
    await setup();
    const done = store.dispatch(new LoadAdminInvoiceDetail('missing'));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/invoices/missing'))
      .flush('not found', { status: 404, statusText: 'Not Found' });
    await done.toPromise();
    expect(snapshot().detailError).toBeTruthy();

    store.dispatch(new DismissAdminInvoiceDetailError());
    expect(snapshot().detailError).toBeNull();
    store.dispatch(new ClearAdminInvoiceDetail());
    const s = snapshot();
    expect(s.detail).toBeNull();
    expect(s.detailStatus).toBe('idle');
  });
});
