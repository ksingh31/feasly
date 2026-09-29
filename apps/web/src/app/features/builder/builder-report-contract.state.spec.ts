/**
 * Builder report-contract state tests.
 *
 * Verifies: the submit posts the exact backend wire shape (integer cents,
 * ISO datetime with offset), success transitions keep the reported value
 * for the confirmation view, RFC 7807 failures surface the server message,
 * idempotent/duplicate outcomes flow through, and reset returns to idle.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import {
  ClearReportContractState,
  SubmitReportContract,
} from './builder-report-contract.actions';
import {
  BuilderReportContractState,
  type BuilderReportContractStateModel,
} from './builder-report-contract.state';

const LEAD_ID = '11111111-1111-4111-8111-111111111111';

const INVOICE = {
  id: 'inv-1',
  status: 'in_review',
  commissionCents: 650000,
  reviewDueAt: '2026-10-06T23:59:59-06:00',
};

/** Flushes the invoice-detail GET the state issues after a billed result. */
function flushInvoiceDetail(httpMock: HttpTestingController) {
  const invoiceReq = httpMock.expectOne((r) =>
    r.url.includes('/api/v1/billing/invoices/inv-1'),
  );
  invoiceReq.flush(INVOICE);
}

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([BuilderReportContractState]),
      {
        provide: ConfigService,
        useValue: {
          get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s],
        },
      },
    ],
  });
  return {
    store: TestBed.inject(Store),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

function snapshot(store: Store): BuilderReportContractStateModel {
  return store.selectSnapshot(
    (state: { builderReportContract: BuilderReportContractStateModel }) =>
      state.builderReportContract,
  );
}

describe('BuilderReportContractState', () => {
  let store: Store;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    ({ store, httpMock } = setup());
  });

  it('posts the exact wire shape: integer cents + ISO datetime with offset', async () => {
    const dispatch = store.dispatch(
      new SubmitReportContract(
        LEAD_ID,
        65000000,
        '2026-09-20T00:00:00-06:00',
      ),
    );
    const req = httpMock.expectOne((r) =>
      r.url.includes('/api/v1/billing/report-contract'),
    );
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      leadId: LEAD_ID,
      contractValueCents: 65000000,
      contractSignedAt: '2026-09-20T00:00:00-06:00',
    });
    req.flush({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' });
    flushInvoiceDetail(httpMock);
    await dispatch.toPromise();

    const state = snapshot(store);
    expect(state.submitStatus).toBe('success');
    expect(state.reportedValueCents).toBe(65000000);
    expect(state.result).toEqual({
      billed: true,
      invoiceId: 'inv-1',
      invoiceStatus: 'in_review',
    });
    expect(state.invoice).toEqual(INVOICE);
    expect(state.error).toBeNull();
  });

  it('succeeds without invoice detail when the invoice fetch fails', async () => {
    const dispatch = store.dispatch(
      new SubmitReportContract(LEAD_ID, 65000000, '2026-09-20T00:00:00Z'),
    );
    const req = httpMock.expectOne((r) =>
      r.url.includes('/api/v1/billing/report-contract'),
    );
    req.flush({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' });
    const invoiceReq = httpMock.expectOne((r) =>
      r.url.includes('/api/v1/billing/invoices/inv-1'),
    );
    invoiceReq.flush(
      { title: 'Not found', status: 404 },
      { status: 404, statusText: 'Not Found' },
    );
    await dispatch.toPromise();

    const state = snapshot(store);
    expect(state.submitStatus).toBe('success');
    expect(state.result).toEqual({
      billed: true,
      invoiceId: 'inv-1',
      invoiceStatus: 'in_review',
    });
    expect(state.invoice).toBeNull();
  });

  it('flows the flat-plan outcome through to the success view', async () => {
    const dispatch = store.dispatch(
      new SubmitReportContract(LEAD_ID, 65000000, '2026-09-20T00:00:00Z'),
    );
    const req = httpMock.expectOne((r) =>
      r.url.includes('/api/v1/billing/report-contract'),
    );
    req.flush({ billed: false, reason: 'flat_subscription_covers' });
    await dispatch.toPromise();

    const state = snapshot(store);
    expect(state.submitStatus).toBe('success');
    expect(state.result).toEqual({
      billed: false,
      reason: 'flat_subscription_covers',
    });
  });

  it('flows the idempotent duplicate outcome through to the success view', async () => {
    const dispatch = store.dispatch(
      new SubmitReportContract(LEAD_ID, 65000000, '2026-09-20T00:00:00Z'),
    );
    const req = httpMock.expectOne((r) =>
      r.url.includes('/api/v1/billing/report-contract'),
    );
    req.flush({
      billed: true,
      invoiceId: 'inv-1',
      invoiceStatus: 'in_review',
      reason: 'existing_invoice',
    });
    flushInvoiceDetail(httpMock);
    await dispatch.toPromise();

    const state = snapshot(store);
    expect(state.submitStatus).toBe('success');
    expect(state.result?.billed).toBe(true);
    if (state.result?.billed) {
      expect(state.result.reason).toBe('existing_invoice');
    }
  });

  it('surfaces the RFC 7807 server message on submit failure', async () => {
    const dispatch = store.dispatch(
      new SubmitReportContract(LEAD_ID, 65000000, '2026-09-20T00:00:00Z'),
    );
    const req = httpMock.expectOne((r) =>
      r.url.includes('/api/v1/billing/report-contract'),
    );
    req.flush(
      { code: 'VALIDATION_FAILED', message: 'Invalid contract report body.' },
      { status: 400, statusText: 'Bad Request' },
    );
    await dispatch.toPromise();

    const state = snapshot(store);
    expect(state.submitStatus).toBe('error');
    expect(state.error?.message).toBe('Invalid contract report body.');
    expect(state.result).toBeNull();
  });

  it('clear resets the state (logout path)', async () => {
    const dispatch = store.dispatch(
      new SubmitReportContract(LEAD_ID, 65000000, '2026-09-20T00:00:00Z'),
    );
    const req = httpMock.expectOne((r) =>
      r.url.includes('/api/v1/billing/report-contract'),
    );
    req.flush({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' });
    flushInvoiceDetail(httpMock);
    await dispatch.toPromise();

    await store.dispatch(new ClearReportContractState()).toPromise();
    expect(snapshot(store).submitStatus).toBe('idle');
  });
});
