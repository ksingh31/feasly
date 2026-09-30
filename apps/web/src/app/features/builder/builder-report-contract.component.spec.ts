/**
 * Builder report-contract component tests.
 *
 * Verifies: the dollars→cents conversion (integer math, never float), the
 * ISO-datetime-with-offset composition, form validation (required fields,
 * invalid amounts, future dates), the submit posts converted cents + the
 * offset datetime, the success view shows the reported amount and the 1%
 * figure, and failures show the RFC 7807 server message.
 *
 * The component is driven through the DOM (no protected-member access),
 * like the other builder-portal component specs.
 *
 * Note: async/await with real timers (not fakeAsync) — zone.js is not
 * installed in this repo, so the fakeAsync helper cannot run here.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type {
  BuilderLeadInvoiceSummary,
  BuilderLeadListResponse,
  CommissionInvoice,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { BuilderState } from './builder.state';
import { BuilderLeadsApiService } from './builder-leads-api.service';
import { BuilderBillingApiService } from './builder-billing-api.service';
import { BuilderInvoicesApiService } from './builder-invoices-api.service';
import { BuilderReportContractComponent } from './builder-report-contract.component';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { dateOnlyToIsoWithOffset } from '../../shared/utils/datetime';
import { parseCadDollarsToCents } from '../../shared/utils/money';
import { BuilderReportContractState } from './builder-report-contract.state';

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const RECORDED_LEAD_ID = '22222222-2222-4222-8222-222222222222';

const INVOICE: CommissionInvoice = {
  id: 'inv-1',
  tenantKey: 'tenant-1',
  attributionId: 'attr-1',
  leadId: LEAD_ID,
  leadName: 'Jane Homeowner',
  contractValueCents: 65000000,
  commissionCents: 650000,
  currency: 'CAD',
  stripePaymentIntentId: null,
  status: 'in_review',
  reviewDueAt: '2026-10-06T23:59:59-06:00',
  finalizedAt: null,
  paidAt: null,
  slaBreached: false,
  disputeReason: null,
  commissionRateOverride: null,
  manualPaymentMethod: null,
  paymentReference: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

const LEADS_RESPONSE: BuilderLeadListResponse = {
  leads: [
    {
      id: LEAD_ID,
      name: 'Jane Homeowner',
      email: 'jane@example.com',
      phone: '403-555-0101',
      timeline: '3–6 months',
      leadScore: 82,
      status: 'quoted',
      statusUpdatedAt: '2026-09-20T10:00:00.000Z',
      addressKey: '123 Main St SW',
      projectType: 'new-build',
      createdAt: '2026-09-19T10:00:00.000Z',
      hasInvoice: false,
      invoiceSummary: null,
      commentCount: 0,
      latestComment: null,
    },
    {
      id: RECORDED_LEAD_ID,
      name: 'Bob Builder',
      email: 'bob@example.com',
      phone: '403-555-0202',
      timeline: '1–3 months',
      leadScore: 91,
      status: 'won',
      statusUpdatedAt: '2026-09-21T10:00:00.000Z',
      addressKey: '456 Oak Ave NW',
      projectType: 'new-build',
      createdAt: '2026-09-18T10:00:00.000Z',
      hasInvoice: true,
      invoiceSummary: INVOICE,
      commentCount: 0,
      latestComment: null,
    },
  ],
  summary: { total: 2, new: 0, contacted: 0, quoted: 1, won: 1, lost: 0 },
};

async function setup(
  reportContractImpl: (
    body: unknown,
  ) => ReturnType<BuilderBillingApiService['reportContract']>,
  leadsImpl: () => ReturnType<BuilderLeadsApiService['listLeads']> = () =>
    of(LEADS_RESPONSE),
  leadQueryParam: string | null = null,
) {
  TestBed.resetTestingModule();
  const calls: unknown[] = [];
  const reportContract = vi.fn((body: unknown) => {
    calls.push(body);
    return reportContractImpl(body);
  });
  const listLeads = vi.fn(leadsImpl);
  const getInvoice = vi.fn((_id: string) => of(INVOICE));
  TestBed.configureTestingModule({
    imports: [BuilderReportContractComponent],
    providers: [
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: leadQueryParam
              ? convertToParamMap({ lead: leadQueryParam })
              : convertToParamMap({}),
          },
        },
      },
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([BuilderState, BuilderReportContractState]),
      {
        provide: ConfigService,
        useValue: {
          get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s],
        },
      },
      {
        provide: BuilderLeadsApiService,
        useValue: { listLeads },
      },
      {
        provide: BuilderBillingApiService,
        useValue: { reportContract },
      },
      {
        provide: BuilderInvoicesApiService,
        useValue: { getInvoice },
      },
    ],
  });
  const fixture: ComponentFixture<BuilderReportContractComponent> =
    TestBed.createComponent(BuilderReportContractComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, calls, listLeads, getInvoice };
}

function setSelect(
  fixture: ComponentFixture<BuilderReportContractComponent>,
  value: string,
): void {
  const select = fixture.nativeElement.querySelector(
    '#report-contract-lead',
  ) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event('input'));
  select.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}

function setInput(
  fixture: ComponentFixture<BuilderReportContractComponent>,
  id: string,
  value: string,
): void {
  const input = fixture.nativeElement.querySelector(
    `#${id}`,
  ) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

async function submitForm(
  fixture: ComponentFixture<BuilderReportContractComponent>,
): Promise<void> {
  const form = fixture.nativeElement.querySelector(
    'form',
  ) as HTMLFormElement;
  form.dispatchEvent(new Event('submit'));
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
}

function fillValidForm(
  fixture: ComponentFixture<BuilderReportContractComponent>,
): void {
  setSelect(fixture, LEAD_ID);
  setInput(fixture, 'report-contract-value', '650000');
  setInput(fixture, 'report-contract-date', '2026-09-20');
}

describe('parseCadDollarsToCents', () => {
  it('converts whole dollars to cents', () => {
    expect(parseCadDollarsToCents('650000')).toBe(65000000);
  });

  it('converts dollars-and-cents without float error', () => {
    // 650000.50 * 100 as a float is 65000049.99… — integer math stays exact.
    expect(parseCadDollarsToCents('650000.50')).toBe(65000050);
    expect(parseCadDollarsToCents('0.07')).toBe(7);
  });

  it('tolerates currency formatting characters', () => {
    expect(parseCadDollarsToCents('$650,000')).toBe(65000000);
  });

  it('rejects invalid amounts', () => {
    expect(parseCadDollarsToCents(null)).toBeNull();
    expect(parseCadDollarsToCents('')).toBeNull();
    expect(parseCadDollarsToCents('abc')).toBeNull();
    expect(parseCadDollarsToCents('650000.555')).toBeNull();
    expect(parseCadDollarsToCents('-100')).toBeNull();
  });
});

describe('dateOnlyToIsoWithOffset', () => {
  it('composes a full ISO datetime with an explicit offset', () => {
    const iso = dateOnlyToIsoWithOffset('2026-09-20');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00([+-]\d{2}:\d{2})$/);
    expect(iso.startsWith('2026-09-20T00:00:00')).toBe(true);
  });
});

describe('BuilderReportContractComponent', () => {
  it('shows the leads picker once leads load', async () => {
    const { fixture } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Jane Homeowner');
    expect(text).toContain('123 Main St SW');
  });

  it('rejects an empty form without calling the API', async () => {
    const { fixture, calls } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    await submitForm(fixture);
    expect(calls).toHaveLength(0);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Choose the lead that signed the contract.');
  });

  it('rejects a future signing date', async () => {
    const { fixture, calls } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    const future = `${new Date().getFullYear() + 1}-01-15`;
    setSelect(fixture, LEAD_ID);
    setInput(fixture, 'report-contract-value', '650000');
    setInput(fixture, 'report-contract-date', future);
    await submitForm(fixture);
    expect(calls).toHaveLength(0);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('can’t be in the future');
  });

  it('rejects an invalid contract amount', async () => {
    const { fixture, calls } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    setSelect(fixture, LEAD_ID);
    setInput(fixture, 'report-contract-value', 'not-a-number');
    setInput(fixture, 'report-contract-date', '2026-09-20');
    await submitForm(fixture);
    expect(calls).toHaveLength(0);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Enter a valid amount');
  });

  it('posts converted cents + an offset datetime, then shows the 1% figure', async () => {
    const { fixture, calls } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    fillValidForm(fixture);
    await submitForm(fixture);

    expect(calls).toHaveLength(1);
    const body = calls[0] as {
      leadId: string;
      contractValueCents: number;
      contractSignedAt: string;
    };
    // The critical conversion: dollars → integer cents (never dollars).
    expect(body.contractValueCents).toBe(65000000);
    expect(body.leadId).toBe(LEAD_ID);
    expect(body.contractSignedAt).toMatch(
      /^2026-09-20T00:00:00([+-]\d{2}:\d{2})$/,
    );

    // Success view: reported amount + 1% of 65000000 cents = 650000 cents.
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('$650,000');
    expect(text).toContain('$6,500');
    expect(text).toContain('7-day review window');
  });

  it('shows the RFC 7807 server message on failure', async () => {
    const { fixture } = await setup(() =>
      throwError(() => ({
        code: 'VALIDATION_FAILED',
        message: 'Invalid contract report body.',
        retryable: false,
      })),
    );
    fillValidForm(fixture);
    await submitForm(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Invalid contract report body.');
  });

  it('shows flat-plan copy when the contract is covered', async () => {
    const { fixture } = await setup(() =>
      of({ billed: false, reason: 'flat_subscription_covers' }),
    );
    fillValidForm(fixture);
    await submitForm(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('flat plan');
  });

  it('shows already-reported copy on an idempotent duplicate', async () => {
    const { fixture } = await setup(() =>
      of({
        billed: true,
        invoiceId: 'inv-1',
        invoiceStatus: 'in_review',
        reason: 'existing_invoice',
      }),
    );
    fillValidForm(fixture);
    await submitForm(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('This contract is already recorded — nothing more to do.');
  });

  it('renders the explainer card, form card, and labeled fields', async () => {
    const { fixture } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    const text = fixture.nativeElement.textContent as string;
    // Explainer card: what happens when a won deal is reported.
    expect(text).toContain('What happens next');
    expect(text).toContain('auto-charges 7 days later unless disputed');
    // Form card + labeled inputs.
    expect(text).toContain('Record details');
    expect(text).toContain('Which lead signed?');
    expect(text).toContain('Contract value (CAD, excluding land)');
    expect(text).toContain('Date the contract was signed');
    expect(text).toContain('Select a lead…');
  });

  it('shows the always-visible commission panel with $0.00 before entry', async () => {
    const { fixture } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Your commission (1%)');
    expect(text).toContain('$0.00');
  });

  it('updates the live 1% commission figure as the value is typed', async () => {
    const { fixture } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    setInput(fixture, 'report-contract-value', '650000');
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Your commission (1%)');
    expect(text).toContain('$6,500');
    expect(text).toContain('$650,000');
  });

  it('shows $0.00 in the commission panel for an invalid amount', async () => {
    const { fixture } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    setInput(fixture, 'report-contract-value', 'not-a-number');
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Your commission (1%)');
    expect(text).toContain('$0.00');
  });

  it('filters recorded leads out of the picker', async () => {
    const { fixture } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    const options = Array.from(
      fixture.nativeElement.querySelectorAll(
        '#report-contract-lead option',
      ) as NodeListOf<HTMLOptionElement>,
    ).map((o) => o.textContent ?? '');
    expect(options.some((o) => o.includes('Jane Homeowner'))).toBe(true);
    expect(options.some((o) => o.includes('Bob Builder'))).toBe(false);
  });

  it('pre-selects the lead passed as a query param', async () => {
    const { fixture } = await setup(
      () => of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
      () => of(LEADS_RESPONSE),
      LEAD_ID,
    );
    const select = fixture.nativeElement.querySelector(
      '#report-contract-lead',
    ) as HTMLSelectElement;
    expect(select.value).toBe(LEAD_ID);
  });

  it('shows the already-recorded state instead of the form for a recorded lead', async () => {
    const { fixture } = await setup(
      () => of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
      () => of(LEADS_RESPONSE),
      RECORDED_LEAD_ID,
    );
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('already recorded');
    expect(fixture.nativeElement.querySelector('form')).toBeNull();
    expect(text).toContain('$6,500');
    expect(text).toContain('View invoice');
    expect(text).toContain('Back to leads');
    expect(text).not.toContain('Report another contract');
  });

  it('shows the no-reportable-leads message when every lead is recorded', async () => {
    const recordedOnly: BuilderLeadListResponse = {
      leads: [LEADS_RESPONSE.leads[1]],
      summary: { total: 1, new: 0, contacted: 0, quoted: 0, won: 1, lost: 0 },
    };
    const { fixture } = await setup(
      () => of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
      () => of(recordedOnly),
    );
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Every lead already has a recorded contract');
    expect(fixture.nativeElement.querySelector('form')).toBeNull();
  });

  it('shows the invoice card with review deadline and auto-charge on success', async () => {
    const { fixture, getInvoice } = await setup(() =>
      of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
    );
    fillValidForm(fixture);
    await submitForm(fixture);

    expect(getInvoice).toHaveBeenCalledWith('inv-1');
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Contract recorded');
    expect(text).toContain('$6,500');
    expect(text).toContain('Oct 6, 2026');
    // Date-dependent: just assert the auto-charge countdown is shown.
    expect(text).toContain('Auto-charges');
    expect(text).toContain('View invoice');
    expect(text).toContain('Back to leads');
    expect(text).not.toContain('Report another contract');
  });

  it('retries the submit from the API-error state', async () => {
    const { fixture, calls } = await setup(() =>
      throwError(() => ({
        code: 'VALIDATION_FAILED',
        message: 'Invalid contract report body.',
        retryable: false,
      })),
    );
    fillValidForm(fixture);
    await submitForm(fixture);
    expect(calls).toHaveLength(1);

    const retry = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ).find((b) => (b as HTMLButtonElement).textContent?.trim() === 'Try again');
    expect(retry).toBeTruthy();
    (retry as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(calls).toHaveLength(2);
  });

  it('reloads the leads picker from the leads-error state', async () => {
    const { fixture, listLeads } = await setup(
      () => of({ billed: true, invoiceId: 'inv-1', invoiceStatus: 'in_review' }),
      () =>
        throwError(() => ({
          code: 'LEADS_FAILED',
          message: 'Leads unavailable.',
          retryable: true,
        })),
    );
    expect(listLeads).toHaveBeenCalledTimes(1);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('couldn’t load your leads');

    const retry = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ).find((b) => (b as HTMLButtonElement).textContent?.trim() === 'Try again');
    expect(retry).toBeTruthy();
    (retry as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(listLeads).toHaveBeenCalledTimes(2);
  });
});
