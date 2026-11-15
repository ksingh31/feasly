/**
 * Lead drawer → record contract (#529): MoneyField + DateField, live
 * commission at the org's configured rate, charge date and card, the kit
 * ConfirmDialog naming amount / card / charge date, then the success state
 * with the minted invoice's countdown.
 */
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BuilderBillingOverviewResponse,
  BuilderLeadListItem,
  CommissionInvoice,
} from '@feasly/contracts';
import { UiConfirmService, type UiConfirmOptions } from '@app/shared/ui';
import { formatEdmontonDatePlusDays } from '../../shared/utils/edmonton';
import { BuilderRecordContractPanelComponent } from './builder-record-contract-panel.component';
import { BUILDER_COPY } from './builder-copy';
import { CHARGE_TIMING_COPY, DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderState } from './builder.state';
import { BuilderBillingState } from './builder-billing.state';
import { BuilderReportContractState } from './builder-report-contract.state';
import { BuilderBillingApiService, type ReportContractResult } from './builder-billing-api.service';
import { BuilderInvoicesApiService } from './builder-invoices-api.service';
import { BuilderLeadsApiService } from './builder-leads-api.service';
import type { BuilderPaymentMethod } from './builder-payment-methods';

const COPY = DEFAULT_BUILDER_COPY;
const T = COPY.leadDrawer.record;

const LEAD: BuilderLeadListItem = {
  id: 'lead-a',
  name: 'Jane Homeowner',
  email: 'jane@example.com',
  phone: null,
  timeline: '0–3 months',
  leadScore: 70,
  status: 'won',
  statusUpdatedAt: '2026-11-14T10:00:00.000Z',
  addressKey: '3415 19 St SW',
  projectType: 'renovation',
  createdAt: '2026-11-12T10:00:00.000Z',
  hasInvoice: false,
  invoiceSummary: null,
  commentCount: 0,
  latestComment: null,
  needsRecording: true,
};

function overview(patch: Partial<BuilderBillingOverviewResponse> = {}): BuilderBillingOverviewResponse {
  return {
    planType: 'commission',
    commissionRatePercent: 1.5,
    currency: 'CAD',
    outstandingCents: 0,
    outstandingCount: 0,
    nextCharge: null,
    failedCount: 0,
    failedInvoices: [],
    disputedCount: 0,
    card: { hasCard: true, brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028 },
    ...patch,
  };
}

const IN_THREE_DAYS = new Date(Date.now() + 3 * 86_400_000).toISOString();

interface Options {
  readonly overview?: BuilderBillingOverviewResponse | 'error';
  readonly method?: BuilderPaymentMethod | 'error' | Subject<{ defaultMethod: BuilderPaymentMethod }>;
  readonly confirm?: boolean;
  readonly report?: Subject<ReportContractResult> | 'error';
}

function setup(options: Options = {}) {
  const billingApi = {
    getOverview: vi.fn(() =>
      options.overview === 'error' ? throwError(() => ({ code: 'http_500' })) : of(options.overview ?? overview()),
    ),
    getDefaultPaymentMethod: vi.fn(() =>
      options.method === 'error'
        ? throwError(() => ({ code: 'http_500' }))
        : options.method instanceof Subject
          ? options.method.asObservable()
          : of({ defaultMethod: options.method ?? 'card' }),
    ),
    reportContract: vi.fn(() => {
      if (options.report === 'error') return throwError(() => ({ code: 'http_500', message: 'Server hiccup.' }));
      return options.report
        ? options.report.asObservable()
        : of<ReportContractResult>({ billed: true, invoiceId: 'inv-9', invoiceStatus: 'in_review' });
    }),
  };
  const invoicesApi = {
    getInvoice: vi.fn(() =>
      of({
        id: 'inv-9',
        commissionCents: 975000,
        paymentMethod: 'card',
        reviewDueAt: IN_THREE_DAYS,
        effectiveRatePercent: 1.5,
      } as unknown as CommissionInvoice),
    ),
  };
  const leadsApi = {
    listLeads: vi.fn(() =>
      of({
        leads: [{ ...LEAD, hasInvoice: true }],
        summary: { total: 1, new: 0, contacted: 0, quoted: 0, won: 1, lost: 0, needsRecording: 0 },
      }),
    ),
    needsYou: vi.fn(() => of({ uncontacted: [], stale: [], wonWithoutContract: [], staleAfterDays: 7, counts: {} })),
  };
  const confirms = {
    confirm: vi.fn((_o: UiConfirmOptions) => of(options.confirm ?? true)),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: BUILDER_COPY, useValue: COPY },
      provideRouter([{ path: '**', children: [] }]),
      provideLocationMocks(),
      provideStore([BuilderState, BuilderBillingState, BuilderReportContractState]),
      { provide: BuilderBillingApiService, useValue: billingApi },
      { provide: BuilderInvoicesApiService, useValue: invoicesApi },
      { provide: BuilderLeadsApiService, useValue: leadsApi },
      { provide: UiConfirmService, useValue: confirms },
    ],
  });
  const fixture = TestBed.createComponent(BuilderRecordContractPanelComponent);
  fixture.componentRef.setInput('lead', LEAD);
  const recorded = vi.fn();
  fixture.componentInstance.recorded.subscribe(recorded);
  fixture.autoDetectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, billingApi, invoicesApi, leadsApi, confirms, recorded, store: TestBed.inject(Store) };
}

/** Poll (with a deadline) for an async UI state — never a fixed sleep. */
async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    TestBed.tick();
  }
}

const text = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? '';

function typeValue(el: HTMLElement, digits: string): void {
  const input = el.querySelector('[data-testid="record-value"] input') as HTMLInputElement;
  input.value = digits;
  input.setSelectionRange(digits.length, digits.length);
  input.dispatchEvent(new Event('input'));
  TestBed.tick();
}

function setDate(el: HTMLElement, value: string): void {
  const input = el.querySelector('[data-testid="record-date"] input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  TestBed.tick();
}

const review = (el: HTMLElement) => el.querySelector('[data-testid="record-review"]') as HTMLButtonElement;

afterEach(() => vi.restoreAllMocks());

describe('BuilderRecordContractPanelComponent (#529)', () => {
  it('previews the commission live at the configured rate, not a hard-coded 1% (AC1)', async () => {
    const { el } = setup();
    await until(() => text(el, 'record-commission-label') !== '', 'preview ready');
    expect(text(el, 'record-commission-label')).toBe('Your commission (1.5%)');
    expect(text(el, 'record-commission')).toBe(T.commissionEmpty);
    typeValue(el, '650000');
    expect((el.querySelector('[data-testid="record-value"] input') as HTMLInputElement).value).toBe('650,000');
    expect(text(el, 'record-commission')).toBe('$9,750');
  });

  it('shows the expected charge date and the card on file', async () => {
    const { el } = setup();
    await until(() => text(el, 'record-card') !== '', 'card row');
    expect(text(el, 'record-card')).toBe('Visa •••• 4242');
    expect(text(el, 'record-charge-date')).toBe(formatEdmontonDatePlusDays(7));
  });

  it('waits for the rate before Review is possible; a failed load offers a retry', async () => {
    const { el, billingApi } = setup({ overview: 'error' });
    await until(() => el.querySelector('[role="alert"]') !== null, 'rate error');
    expect(el.textContent).toContain(T.rateError);
    expect(review(el).disabled).toBe(true);
    expect(el.querySelector('[data-testid="record-commission"]')).toBeNull();
    billingApi.getOverview.mockReturnValue(of(overview()));
    (el.querySelector('[data-testid="record-preview"] button') as HTMLButtonElement).click();
    await until(() => !review(el).disabled, 'review enabled after retry');
  });

  it('a failed default-method load keeps Review disabled with no card promise, then retries', async () => {
    const { el, billingApi, confirms } = setup({ method: 'error' });
    await until(() => el.querySelector('[role="alert"]') !== null, 'billing error');
    expect(el.textContent).toContain(T.rateError);
    expect(review(el).disabled).toBe(true);
    expect(el.querySelector('[data-testid="record-card"]')).toBeNull();
    expect(el.querySelector('[data-testid="record-charge-date"]')).toBeNull();
    expect(el.textContent).not.toContain('4242');
    typeValue(el, '650000');
    review(el).click();
    TestBed.tick();
    expect(confirms.confirm).not.toHaveBeenCalled();
    billingApi.getDefaultPaymentMethod.mockReturnValue(of({ defaultMethod: 'cheque' }));
    (el.querySelector('[data-testid="record-preview"] button') as HTMLButtonElement).click();
    await until(() => !review(el).disabled, 'review enabled after retry');
    expect(text(el, 'record-card')).toBe('Paid by cheque — no card charge');
  });

  it('a slow default-method load keeps Review disabled until the method is known', async () => {
    const method = new Subject<{ defaultMethod: BuilderPaymentMethod }>();
    const { el } = setup({ method });
    await until(() => el.querySelector('[data-testid="record-preview"] [role="status"]') !== null, 'loading');
    expect(review(el).disabled).toBe(true);
    expect(el.querySelector('[data-testid="record-card"]')).toBeNull();
    method.next({ defaultMethod: 'cheque' });
    method.complete();
    await until(() => !review(el).disabled, 'review enabled once method known');
    expect(text(el, 'record-card')).toBe('Paid by cheque — no card charge');
  });

  it('validates value and date before confirming', async () => {
    const { el, confirms } = setup();
    await until(() => !review(el).disabled, 'ready');
    setDate(el, '2999-01-01');
    review(el).click();
    TestBed.tick();
    expect(el.textContent).toContain(T.valueRequired);
    expect(el.textContent).toContain(T.dateFuture);
    expect(confirms.confirm).not.toHaveBeenCalled();
  });

  it('the confirm names the amount, the card and the charge date (AC2), then creates the invoice', async () => {
    const { el, confirms, billingApi, recorded, leadsApi } = setup();
    await until(() => !review(el).disabled, 'ready');
    typeValue(el, '650000');
    setDate(el, '2026-11-10');
    review(el).click();
    expect(confirms.confirm).toHaveBeenCalledTimes(1);
    const options = confirms.confirm.mock.calls[0][0];
    expect(options.title).toBe('Record the contract for Jane Homeowner?');
    expect(options.body).toContain('$9,750');
    expect(options.body).toContain('1.5% of $650,000');
    expect(options.body).toContain('Visa •••• 4242');
    expect(options.body).toContain(formatEdmontonDatePlusDays(7));
    expect(options.body).toContain(CHARGE_TIMING_COPY);
    expect(options.verb).toBe(T.confirmVerb);

    await until(() => !!el.querySelector('[data-testid="record-success"]'), 'success');
    expect(billingApi.reportContract).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead-a', contractValueCents: 65000000 }),
    );
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(leadsApi.listLeads).toHaveBeenCalled();
    expect(text(el, 'record-success-commission')).toBe('$9,750');
    expect(text(el, 'record-success-countdown')).toBe('Charges in 3 days');
    expect(el.querySelector('[data-testid="record-success-invoice"]')?.getAttribute('href')).toBe(
      '/builder/invoices?invoice=inv-9',
    );
  });

  it('Cancel in the confirm creates nothing', async () => {
    const { el, billingApi } = setup({ confirm: false });
    await until(() => !review(el).disabled, 'ready');
    typeValue(el, '650000');
    review(el).click();
    TestBed.tick();
    expect(billingApi.reportContract).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="record-success"]')).toBeNull();
  });

  it('a failed submit shows the error inline with a retry', async () => {
    const { el, billingApi } = setup({ report: 'error' });
    await until(() => !review(el).disabled, 'ready');
    typeValue(el, '650000');
    review(el).click();
    await until(() => !!el.querySelector('[data-testid="record-error"]'), 'error');
    expect(text(el, 'record-error')).toContain('Server hiccup.');
    billingApi.reportContract.mockReturnValue(
      of<ReportContractResult>({ billed: true, invoiceId: 'inv-9', invoiceStatus: 'in_review' }),
    );
    (el.querySelector('[data-testid="record-error"] button') as HTMLButtonElement).click();
    await until(() => !!el.querySelector('[data-testid="record-success"]'), 'success after retry');
  });

  it('shows the review button busy while the invoice is created', async () => {
    const report = new Subject<ReportContractResult>();
    const { el } = setup({ report });
    await until(() => !review(el).disabled, 'ready');
    typeValue(el, '650000');
    review(el).click();
    TestBed.tick();
    expect(review(el).getAttribute('aria-busy')).toBe('true');
    expect(el.textContent).toContain(T.submitting);
    report.next({ billed: true, invoiceId: 'inv-9', invoiceStatus: 'in_review' });
    report.complete();
    await until(() => !!el.querySelector('[data-testid="record-success"]'), 'success');
  });

  it('no card on file: names the charge date and links to add a card', async () => {
    const { el, confirms } = setup({ overview: overview({ card: { hasCard: false } }) });
    await until(() => text(el, 'record-card') !== '', 'card row');
    expect(text(el, 'record-card')).toContain(T.noCard);
    expect(el.querySelector('[data-testid="record-card"] a')?.getAttribute('href')).toBe('/builder/billing');
    typeValue(el, '650000');
    review(el).click();
    const body = confirms.confirm.mock.calls[0][0].body;
    expect(body).toContain(formatEdmontonDatePlusDays(7));
    expect(body).toContain('Add a card');
  });

  it('manual default method: no card-charge promise', async () => {
    const { el, confirms } = setup({ method: 'cheque' });
    await until(() => text(el, 'record-card') !== '', 'payment row');
    expect(text(el, 'record-card')).toBe('Paid by cheque — no card charge');
    expect(el.querySelector('[data-testid="record-charge-date"]')).toBeNull();
    typeValue(el, '650000');
    review(el).click();
    const body = confirms.confirm.mock.calls[0][0].body;
    expect(body).toContain('paid by cheque');
    expect(body).not.toContain(CHARGE_TIMING_COPY);
  });

  it('flat plan: no commission preview; the confirm records without an invoice amount', async () => {
    const { el, confirms } = setup({ overview: overview({ planType: 'flat', commissionRatePercent: null, card: null }) });
    await until(() => !!el.querySelector('[data-testid="record-flat"]'), 'flat note');
    expect(el.querySelector('[data-testid="record-commission"]')).toBeNull();
    typeValue(el, '650000');
    review(el).click();
    const options = confirms.confirm.mock.calls[0][0];
    expect(options.verb).toBe(T.confirmVerbFlat);
    expect(options.body).toContain('$650,000');
  });
});
