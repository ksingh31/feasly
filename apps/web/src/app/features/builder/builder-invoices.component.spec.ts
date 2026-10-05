/**
 * Builder invoices component tests (BILL-04).
 *
 * Verifies: list states (loading / empty / error / populated), the
 * review-deadline countdown, status pills, the failed-charge banner with
 * its "update your card" CTA, the paid-invoice receipt, and pagination.
 *
 * The invoice API is stubbed with fixture invoices — these tests assert
 * the UI contract against the documented wire shape, not the backend.
 *
 * Note: async/await with real timers (not fakeAsync) — zone.js is not
 * installed in this repo, so the fakeAsync helper cannot run here.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import {
  BuilderInvoicesApiService,
  type BuilderCommissionInvoice,
} from './builder-invoices-api.service';
import type { BuilderPaymentMethod } from './builder-payment-methods';
import { BuilderBillingState } from './builder-billing.state';
import { BuilderInvoicesComponent } from './builder-invoices.component';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderInvoicesState } from './builder-invoices.state';
import { ClearInvoicesState, LoadInvoices } from './builder-invoices.actions';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

/** Fixture invoices mirroring the live wire shape (one per visible status). */
function testInvoices(): BuilderCommissionInvoice[] {
  const day = 86_400_000;
  const now = Date.now();
  const iso = (t: number): string => new Date(t).toISOString();
  const base = {
    tenantKey: 't1',
    currency: 'CAD',
    stripePaymentIntentId: null,
    finalizedAt: null,
    paidAt: null,
    slaBreached: false,
    disputeReason: null,
    commissionRateOverride: null,
    manualPaymentMethod: null,
    paymentReference: null,
    invoiceNumber: 'INV-0001',
    paymentMethod: 'card',
    commissionRatePercent: 1,
    effectiveRatePercent: 1,
    leadName: 'Test Lead',
  } as const;
  return [
    {
      ...base,
      id: 'inv-test-001',
      invoiceNumber: 'INV-0042',
      attributionId: 'a1',
      leadId: 'l1',
      leadName: 'Ava Brown',
      contractValueCents: 68500000,
      commissionCents: 685000,
      status: 'in_review',
      reviewDueAt: iso(now + 3 * day),
      createdAt: iso(now - 4 * day),
      updatedAt: iso(now - 4 * day),
    },
    {
      ...base,
      id: 'inv-test-002',
      invoiceNumber: 'INV-0041',
      attributionId: 'a2',
      leadId: 'l2',
      leadName: 'Liam Chen',
      contractValueCents: 74250000,
      commissionCents: 742500,
      stripePaymentIntentId: 'pi_test_paid_001',
      status: 'paid',
      reviewDueAt: iso(now - 9 * day),
      finalizedAt: iso(now - 2 * day),
      paidAt: iso(now - 2 * day),
      createdAt: iso(now - 9 * day),
      updatedAt: iso(now - 2 * day),
    },
    {
      ...base,
      id: 'inv-test-003',
      invoiceNumber: 'INV-0040',
      attributionId: 'a3',
      leadId: 'l3',
      contractValueCents: 59800000,
      commissionCents: 598000,
      stripePaymentIntentId: 'pi_test_failed_001',
      status: 'failed',
      reviewDueAt: iso(now - 3 * day),
      finalizedAt: iso(now - 3 * day),
      createdAt: iso(now - 10 * day),
      updatedAt: iso(now - 1 * day),
    },
    {
      ...base,
      id: 'inv-test-004',
      invoiceNumber: 'INV-0039',
      attributionId: 'a4',
      leadId: 'l4',
      contractValueCents: 81000000,
      commissionCents: 810000,
      status: 'disputed',
      reviewDueAt: iso(now - 5 * day),
      slaBreached: true,
      disputeReason: 'Contract value disputed',
      createdAt: iso(now - 12 * day),
      updatedAt: iso(now - 5 * day),
    },
    {
      ...base,
      id: 'inv-test-005',
      invoiceNumber: 'INV-0038',
      attributionId: 'a5',
      leadId: 'l5',
      contractValueCents: 65500000,
      commissionCents: 655000,
      stripePaymentIntentId: 'pi_test_paid_002',
      status: 'paid',
      reviewDueAt: iso(now - 16 * day),
      finalizedAt: iso(now - 9 * day),
      paidAt: iso(now - 9 * day),
      createdAt: iso(now - 16 * day),
      updatedAt: iso(now - 9 * day),
    },
    {
      ...base,
      id: 'inv-test-006',
      invoiceNumber: 'INV-0037',
      attributionId: 'a6',
      leadId: 'l6',
      contractValueCents: 70300000,
      commissionCents: 703000,
      status: 'finalized',
      reviewDueAt: iso(now - 1 * day),
      finalizedAt: iso(now - 1 * day),
      createdAt: iso(now - 8 * day),
      updatedAt: iso(now - 1 * day),
    },
  ];
}

/** Wait out NGXS dispatch microtasks after the stubbed API resolves. */
async function flushMock(fixture: ComponentFixture<BuilderInvoicesComponent>) {
  await new Promise((r) => setTimeout(r, 50));
  fixture.detectChanges();
  await fixture.whenStable();
}

async function setupWithInvoices(
  response: {
    invoices: readonly BuilderCommissionInvoice[];
    total: number | null;
    page: number;
    pageSize: number;
  },
  overrides?: {
    setInvoicePaymentMethod?: (
      id: string,
      method: BuilderPaymentMethod,
    ) => Observable<BuilderCommissionInvoice>;
  },
) {
  TestBed.resetTestingModule();
  const invoices = [...response.invoices];
  const putCalls: Array<{ id: string; method: BuilderPaymentMethod }> = [];
  const apiMock = {
    /** Every PUT /invoices/{id}/payment-method call, in order. */
    putCalls,
    listInvoices: () => of(response),
    getInvoice: (id: string) => {
      const found = invoices.find((inv) => inv.id === id);
      if (!found) {
        throw new Error(`Test invoice not found: ${id}`);
      }
      return of(found);
    },
    // Mirrors the PUT /invoices/{id}/payment-method wire shape: the
    // backend returns the updated invoice.
    setInvoicePaymentMethod: (
      id: string,
      method: BuilderPaymentMethod,
    ): Observable<BuilderCommissionInvoice> => {
      putCalls.push({ id, method });
      if (overrides?.setInvoicePaymentMethod) {
        return overrides.setInvoicePaymentMethod(id, method);
      }
      const found = invoices.find((inv) => inv.id === id);
      if (!found) {
        throw new Error(`Test invoice not found: ${id}`);
      }
      const updated = { ...found, paymentMethod: method };
      const index = invoices.findIndex((inv) => inv.id === id);
      invoices[index] = updated;
      return of(updated);
    },
  };
  TestBed.configureTestingModule({
    imports: [BuilderInvoicesComponent],
    providers: [
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([BuilderBillingState, BuilderInvoicesState]),
      { provide: ConfigService, useValue: { get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s] } },
      { provide: BuilderInvoicesApiService, useValue: apiMock },
    ],
  });
  const fixture: ComponentFixture<BuilderInvoicesComponent> =
    TestBed.createComponent(BuilderInvoicesComponent);
  const store = TestBed.inject(Store);
  return { fixture, store, apiMock };
}

async function setup() {
  const invoices = testInvoices();
  return setupWithInvoices({
    invoices,
    total: invoices.length,
    page: 1,
    pageSize: 10,
  });
}

describe('BuilderInvoicesComponent (BILL-04)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('renders the invoice list with status pills and amounts', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Invoices');
    // Fixtures: one in-review, two paid, one failed, one disputed, one finalized.
    expect(text).toContain('In review');
    expect(text).toContain('Paid');
    expect(text).toContain('Failed');
    expect(text).toContain('Disputed');
    // Commission amounts render via the shared money util.
    expect(text).toContain('$6,850');
  });

  it('labels the detail view with the invoice\u2019s own effective rate (billing/08)', async () => {
    const invoices = testInvoices().map((inv, i) =>
      i === 0
        ? { ...inv, commissionRatePercent: 2, effectiveRatePercent: 2 }
        : inv,
    );
    const { fixture } = await setupWithInvoices({
      invoices,
      total: invoices.length,
      page: 1,
      pageSize: 10,
    });
    fixture.detectChanges();
    await flushMock(fixture);

    // The rate label lives in the detail view, not the list rows.
    expect(fixture.nativeElement.textContent as string).not.toContain(
      'Commission (2%)',
    );

    // Open the first invoice's detail view (the 2% one).
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    expect(buttons.length).toBeGreaterThan(0);
    buttons[0].click();
    await flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Commission (2%)');
  });

  it('renders the lead name in its own column for each invoice', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const headers = [
      ...fixture.nativeElement.querySelectorAll(
        '.builder-invoices__table thead th',
      ),
    ].map((th: Element) => th.textContent?.trim());
    expect(headers).toContain('Lead');
    // Lead column sits right after the date column.
    expect(headers.indexOf('Lead')).toBe(headers.indexOf('Date') + 1);

    const rows = fixture.nativeElement.querySelectorAll(
      '.builder-invoices__table tbody tr',
    );
    const firstRowCells = [...rows[0].querySelectorAll('td')].map(
      (td: Element) => td.textContent?.trim(),
    );
    expect(firstRowCells).toContain('Ava Brown');
    const secondRowCells = [...rows[1].querySelectorAll('td')].map(
      (td: Element) => td.textContent?.trim(),
    );
    expect(secondRowCells).toContain('Liam Chen');
  });

  it('shows the review-deadline countdown for in-review invoices', async () => {    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    // Fixture in-review invoice has reviewDueAt 3 days out (Edmonton calendar).
    expect(text).toContain('Auto-charges in 3 days');
  });

  it('shows "Due in X days" (no auto-charge) for manual-method in-review invoices', async () => {
    const invoices = testInvoices().map((inv) =>
      inv.status === 'in_review' ? { ...inv, paymentMethod: 'cheque' as const } : inv,
    );
    const { fixture } = await setupWithInvoices({
      invoices,
      total: invoices.length,
      page: 1,
      pageSize: 10,
    });
    fixture.detectChanges();
    await flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Due in 3 days');
    expect(text).not.toContain('Auto-charges');
  });

  it('shows "Due tomorrow" for a manual-method invoice due tomorrow', async () => {
    const day = 86_400_000;
    const invoices = testInvoices().map((inv) =>
      inv.status === 'in_review'
        ? {
            ...inv,
            paymentMethod: 'e_transfer' as const,
            reviewDueAt: new Date(Date.now() + 1 * day).toISOString(),
          }
        : inv,
    );
    const { fixture } = await setupWithInvoices({
      invoices,
      total: invoices.length,
      page: 1,
      pageSize: 10,
    });
    fixture.detectChanges();
    await flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Due tomorrow');
    expect(text).not.toContain('Auto-charges');
  });

  it('renders the payment method label in its own column', async () => {
    const invoices = testInvoices().map((inv, i) =>
      i === 0 ? { ...inv, paymentMethod: 'cheque' as const } : inv,
    );
    const { fixture } = await setupWithInvoices({
      invoices,
      total: invoices.length,
      page: 1,
      pageSize: 10,
    });
    fixture.detectChanges();
    await flushMock(fixture);

    const headers = [
      ...fixture.nativeElement.querySelectorAll(
        '.builder-invoices__table thead th',
      ),
    ].map((th: Element) => th.textContent?.trim());
    expect(headers).toContain('Payment method');

    const methodCells = [
      ...fixture.nativeElement.querySelectorAll('.builder-invoices__method'),
    ].map((el: Element) => el.textContent?.trim());
    expect(methodCells).toContain('Cheque');
  });

  it('opens the detail view with a failed-charge banner and update-card CTA', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    // Click the failed invoice's date button (third row in fixture order).
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    expect(buttons.length).toBeGreaterThan(0);
    buttons[2].click();
    await flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Your card was declined');
    expect(text).toContain('Update your card');
    // Timeline renders without any dispute affordance.
    expect(text).toContain('Status timeline');
    expect(text).not.toMatch(/dispute this/i);
  });

  it('renders receipt details for a paid invoice', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[1].click(); // paid invoice
    await flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Payment received');
    expect(text).toContain('Receipt');
    expect(text).toContain('Amount charged');
  });

  it('shows the invoice number in the detail view (billing/12)', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[0].click(); // in_review invoice
    await flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Invoice number');
    expect(text).toContain('INV-0042');
  });

  it('renders a payment-method select for an editable invoice (billing/12)', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[0].click(); // in_review invoice
    await flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Payment method');
    const select = fixture.nativeElement.querySelector(
      '#invoice-payment-method',
    ) as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe('card');
    const options = Array.from(select.options).map((o) => o.textContent?.trim());
    expect(options).toEqual(['Card', 'Cheque', 'E-transfer', 'Bank draft']);
  });

  it('does not save the payment method on select alone — Apply is required (Karan 2026-10-02)', async () => {
    const invoices = testInvoices();
    const { fixture, apiMock } = await setupWithInvoices({
      invoices,
      total: invoices.length,
      page: 1,
      pageSize: 10,
    });
    fixture.detectChanges();
    await flushMock(fixture);

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[0].click(); // in_review invoice
    await flushMock(fixture);

    const select = fixture.nativeElement.querySelector(
      '#invoice-payment-method',
    ) as HTMLSelectElement;
    select.value = 'cheque';
    select.dispatchEvent(new Event('change'));
    await flushMock(fixture);

    // The choice is staged in the dropdown, but nothing hits the API.
    expect(apiMock.putCalls).toEqual([]);
    expect(select.value).toBe('cheque');
    // The review note still describes the SAVED method (card auto-charge).
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('charged automatically');
    expect(text).not.toContain('Your card won’t be charged');
  });

  it('disables Apply until the selection differs from the saved method', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[0].click(); // in_review invoice
    await flushMock(fixture);

    const apply = fixture.nativeElement.querySelector(
      '.builder-invoices__apply',
    ) as HTMLButtonElement;
    expect(apply).not.toBeNull();
    expect(apply.disabled).toBe(true);

    const select = fixture.nativeElement.querySelector(
      '#invoice-payment-method',
    ) as HTMLSelectElement;
    select.value = 'cheque';
    select.dispatchEvent(new Event('change'));
    await flushMock(fixture);
    expect(apply.disabled).toBe(false);

    // Re-selecting the saved method clears the staged change.
    select.value = 'card';
    select.dispatchEvent(new Event('change'));
    await flushMock(fixture);
    expect(apply.disabled).toBe(true);
  });

  it('Apply PUTs the staged method and switches the review note to the manual copy', async () => {
    const invoices = testInvoices();
    const { fixture, apiMock } = await setupWithInvoices({
      invoices,
      total: invoices.length,
      page: 1,
      pageSize: 10,
    });
    fixture.detectChanges();
    await flushMock(fixture);

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[0].click(); // in_review invoice
    await flushMock(fixture);

    const select = fixture.nativeElement.querySelector(
      '#invoice-payment-method',
    ) as HTMLSelectElement;
    select.value = 'cheque';
    select.dispatchEvent(new Event('change'));
    await flushMock(fixture);

    (
      fixture.nativeElement.querySelector(
        '.builder-invoices__apply',
      ) as HTMLButtonElement
    ).click();
    await flushMock(fixture);

    expect(apiMock.putCalls).toEqual([
      { id: 'inv-test-001', method: 'cheque' },
    ]);
    const updated = fixture.nativeElement.querySelector(
      '#invoice-payment-method',
    ) as HTMLSelectElement;
    expect(updated.value).toBe('cheque');
    const text = fixture.nativeElement.textContent as string;
    // The SAVED method is now cheque: the manual review note replaces the
    // card auto-charge wording, and the saved confirmation shows.
    expect(text).toContain('Your card won’t be charged — pay by cheque');
    expect(text).not.toContain('charged automatically');
    expect(text).toContain('Payment method updated.');
    // Apply is disabled again — nothing left to apply.
    expect(
      (
        fixture.nativeElement.querySelector(
          '.builder-invoices__apply',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('reverts the select to the saved method and shows the error when Apply fails', async () => {
    const invoices = testInvoices();
    const { fixture, apiMock } = await setupWithInvoices(
      {
        invoices,
        total: invoices.length,
        page: 1,
        pageSize: 10,
      },
      {
        setInvoicePaymentMethod: () =>
          throwError(() => new Error('PUT failed')),
      },
    );
    fixture.detectChanges();
    await flushMock(fixture);

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[0].click(); // in_review invoice
    await flushMock(fixture);

    const select = fixture.nativeElement.querySelector(
      '#invoice-payment-method',
    ) as HTMLSelectElement;
    select.value = 'cheque';
    select.dispatchEvent(new Event('change'));
    await flushMock(fixture);

    (
      fixture.nativeElement.querySelector(
        '.builder-invoices__apply',
      ) as HTMLButtonElement
    ).click();
    await flushMock(fixture);

    // The PUT was attempted…
    expect(apiMock.putCalls).toEqual([
      { id: 'inv-test-001', method: 'cheque' },
    ]);
    // …but the dropdown snapped back to the saved method and the
    // failure copy surfaced.
    const reverted = fixture.nativeElement.querySelector(
      '#invoice-payment-method',
    ) as HTMLSelectElement;
    expect(reverted.value).toBe('card');
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('We couldn’t change the payment method');
    // The review note still describes the SAVED method (card auto-charge).
    expect(text).toContain('charged automatically');
  });

  it('Reset discards the staged change without saving', async () => {
    const invoices = testInvoices();
    const { fixture, apiMock } = await setupWithInvoices({
      invoices,
      total: invoices.length,
      page: 1,
      pageSize: 10,
    });
    fixture.detectChanges();
    await flushMock(fixture);

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[0].click(); // in_review invoice
    await flushMock(fixture);

    const select = fixture.nativeElement.querySelector(
      '#invoice-payment-method',
    ) as HTMLSelectElement;
    select.value = 'cheque';
    select.dispatchEvent(new Event('change'));
    await flushMock(fixture);

    const reset = fixture.nativeElement.querySelector(
      '.builder-invoices__reset',
    ) as HTMLButtonElement;
    expect(reset).not.toBeNull();
    reset.click();
    await flushMock(fixture);

    expect(apiMock.putCalls).toEqual([]);
    const reverted = fixture.nativeElement.querySelector(
      '#invoice-payment-method',
    ) as HTMLSelectElement;
    expect(reverted.value).toBe('card');
    expect(
      (
        fixture.nativeElement.querySelector(
          '.builder-invoices__apply',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('locks the payment method with an explainer for paid invoices (billing/12)', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[1].click(); // paid invoice
    await flushMock(fixture);

    expect(
      fixture.nativeElement.querySelector('#invoice-payment-method'),
    ).toBeNull();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(
      'Payment method can’t be changed once an invoice is settled.',
    );
  });

  it('locks the payment method with an explainer for disputed invoices (billing/12)', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[3].click(); // disputed invoice
    await flushMock(fixture);

    expect(
      fixture.nativeElement.querySelector('#invoice-payment-method'),
    ).toBeNull();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(
      'Payment method can’t be changed once an invoice is settled.',
    );
  });

  it('renders the manual review note for an in-review cheque invoice (billing/12)', async () => {
    const invoices = testInvoices().map((inv, i) =>
      i === 0 ? { ...inv, paymentMethod: 'cheque' as const } : inv,
    );
    const { fixture } = await setupWithInvoices({
      invoices,
      total: invoices.length,
      page: 1,
      pageSize: 10,
    });
    fixture.detectChanges();
    await flushMock(fixture);

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[0].click();
    await flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Your card won’t be charged — pay by cheque');
  });

  it('card review note no longer references a builder dispute flow (QA 2026-10-04)', async () => {
    // Builders cannot open disputes (UI deferred) and the admin console
    // can only resolve them — the copy must not promise a dispute path.
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[0].click(); // in_review invoice
    await flushMock(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('charged automatically');
    expect(text).toContain('contact Feasly if something looks wrong');
    expect(text).not.toContain('disputed through the admin console');
  });

  it('renders no tabs: invoices is a top-level tab, not under billing', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const tabs = fixture.nativeElement.querySelectorAll('.builder-invoices__tab');
    expect(tabs.length).toBe(0);
  });

  it('renders the loading skeleton while the invoice list is in flight', async () => {
    const { Subject } = await import('rxjs');
    // A Subject that never emits until the test drives it, so the state
    // stays at 'loading' long enough to observe the skeleton.
    const listSubject = new Subject();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [BuilderInvoicesComponent],
      providers: [
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([BuilderBillingState, BuilderInvoicesState]),
        { provide: ConfigService, useValue: { get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s] } },
        {
          provide: BuilderInvoicesApiService,
          useValue: {
            listInvoices: () => listSubject.asObservable(),
            getInvoice: () => {
              throw new Error('not used');
            },
          },
        },
      ],
    });
    const fixture: ComponentFixture<BuilderInvoicesComponent> =
      TestBed.createComponent(BuilderInvoicesComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    const skeleton = fixture.nativeElement.querySelector(
      '.builder-invoices__skeleton--table',
    );
    expect(skeleton).not.toBeNull();
    expect(skeleton.getAttribute('role')).toBe('status');
    expect(skeleton.getAttribute('aria-label')).toContain('Loading');

    listSubject.next({ invoices: [], total: 0, page: 1, pageSize: 10 });
    await flushMock(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No invoices yet');
  });

  it('redispatches the invoice list when the retry button is clicked', async () => {
    const { throwError } = await import('rxjs');
    const invoices = testInvoices();
    TestBed.resetTestingModule();
    const listSpy = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('boom')))
      .mockReturnValue(
        of({ invoices, total: invoices.length, page: 1, pageSize: 10 }),
      );
    const apiMock = {
      listInvoices: listSpy,
      getInvoice: (id: string) => of(invoices.find((i) => i.id === id)!),
    };
    TestBed.configureTestingModule({
      imports: [BuilderInvoicesComponent],
      providers: [
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([BuilderBillingState, BuilderInvoicesState]),
        { provide: ConfigService, useValue: { get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s] } },
        { provide: BuilderInvoicesApiService, useValue: apiMock },
      ],
    });
    const fixture: ComponentFixture<BuilderInvoicesComponent> =
      TestBed.createComponent(BuilderInvoicesComponent);
    fixture.detectChanges();
    await flushMock(fixture);

    const alert = fixture.nativeElement.querySelector(
      '.builder-invoices__alert',
    );
    expect(alert).not.toBeNull();
    (alert.querySelector('button') as HTMLButtonElement).click();
    await flushMock(fixture);

    expect(listSpy).toHaveBeenCalledTimes(2);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('$6,850');
  });

  it('paginates the invoice list', async () => {
    const { fixture, store } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    // 6 fixture invoices, page size 10 → single page.
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Page 1 of 1');
    const next = fixture.nativeElement.querySelector(
      '.builder-invoices__pagination button:last-child',
    ) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(store.selectSnapshot(BuilderInvoicesState.page)).toBe(1);
  });

  it('shows "Page N" without a page count when the backend reports no total', async () => {
    // Simulate the live backend shape: bare array, total unknown (null).
    const { fixture } = await setupWithInvoices({
      invoices: [
        {
          id: 'inv-1',
          invoiceNumber: 'INV-0001',
          paymentMethod: 'card',
          tenantKey: 't1',
          attributionId: 'a1',
          leadId: 'l1',
          leadName: 'Test Lead',
          contractValueCents: 10000000,
          commissionCents: 100000,
          currency: 'CAD',
          stripePaymentIntentId: null,
          status: 'finalized',
          reviewDueAt: null,
          finalizedAt: new Date().toISOString(),
          paidAt: null,
          slaBreached: false,
          disputeReason: null,
          commissionRateOverride: null,
          manualPaymentMethod: null,
          paymentReference: null,
          commissionRatePercent: 1,
          effectiveRatePercent: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: null,
      page: 1,
      pageSize: 10,
    });
    fixture.detectChanges();
    await flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Page 1');
    expect(text).not.toContain('Page 1 of');
    // 1 invoice < page size 10 → last page, Next disabled.
    const next = fixture.nativeElement.querySelector(
      '.builder-invoices__pagination button:last-child',
    ) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
  });
});

/**
 * Pagination param validity (2026-09-29, live bug): the invoices list
 * intermittently 400'd because the frontend sent invalid limit/offset to
 * GET /api/v1/billing/invoices (zod: limit 1–100, offset ≥ 0). Root causes
 * fixed: ClearInvoicesState reset pageSize to 0 (ngxsOnInit runs once, so
 * revisiting the page sent limit=0), and Math.max(1, NaN) is NaN, poisoning
 * the page signal and every retry after it. These tests run the real API
 * service against HttpTestingController and assert the wire params.
 */
describe('BuilderInvoices pagination params (no 400)', () => {
  function setupRealApi() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([BuilderInvoicesState]),
        {
          provide: ConfigService,
          useValue: {
            get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s],
          },
        },
        // NOTE: no BuilderInvoicesApiService override — the real one runs.
      ],
    });
    const store = TestBed.inject(Store);
    const httpMock = TestBed.inject(HttpTestingController);
    return { store, httpMock };
  }

  function expectListRequest(
    httpMock: HttpTestingController,
    limit: string,
    offset: string,
  ) {
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/billing/invoices'),
    );
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('limit')).toBe(limit);
    expect(req.request.params.get('offset')).toBe(offset);
    req.flush([]);
    return req;
  }

  it('sends limit=10&offset=0 for the initial page-1 load', () => {
    const { store, httpMock } = setupRealApi();
    store.dispatch(new LoadInvoices(1));
    expectListRequest(httpMock, '10', '0');
    expect(store.selectSnapshot(BuilderInvoicesState.page)).toBe(1);
    httpMock.verify();
  });

  it('sends valid params after ClearInvoicesState (the live 400 repro)', () => {
    const { store, httpMock } = setupRealApi();
    // Navigate away: the component dispatches ClearInvoicesState on destroy,
    // resetting pageSize to the 0 default (ngxsOnInit does not re-run).
    store.dispatch(new ClearInvoicesState());
    expect(store.selectSnapshot(BuilderInvoicesState.pageSize)).toBe(0);
    // Navigate back: the revisit must NOT send limit=0.
    store.dispatch(new LoadInvoices(1));
    expectListRequest(httpMock, '10', '0');
    // The state heals itself for the next visit too.
    expect(store.selectSnapshot(BuilderInvoicesState.pageSize)).toBe(10);
    httpMock.verify();
  });

  it('clamps non-finite and out-of-range pages to page 1', () => {
    const { store, httpMock } = setupRealApi();
    for (const badPage of [Number.NaN, 0, -3]) {
      store.dispatch(new LoadInvoices(badPage));
      expectListRequest(httpMock, '10', '0');
      // The poisoned-page path: NaN must not stick in the page signal and
      // poison the retry path after it.
      expect(store.selectSnapshot(BuilderInvoicesState.page)).toBe(1);
    }
    // Fractional pages floor to an integer page.
    store.dispatch(new LoadInvoices(2.7));
    expectListRequest(httpMock, '10', '10');
    expect(store.selectSnapshot(BuilderInvoicesState.page)).toBe(2);
    httpMock.verify();
  });

  it('sends offset=10 for page 2 (Next pager path)', () => {
    const { store, httpMock } = setupRealApi();
    store.dispatch(new LoadInvoices(2));
    expectListRequest(httpMock, '10', '10');
    expect(store.selectSnapshot(BuilderInvoicesState.page)).toBe(2);
    httpMock.verify();
  });

  it('retry after an error sends valid params', () => {
    const { store, httpMock } = setupRealApi();
    store.dispatch(new ClearInvoicesState());
    store.dispatch(new LoadInvoices(1));
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/billing/invoices'),
    );
    expect(req.request.params.get('limit')).toBe('10');
    expect(req.request.params.get('offset')).toBe('0');
    req.flush(
      { code: 'VALIDATION_FAILED', message: 'Bad pagination.', retryable: false },
      { status: 400, statusText: 'Bad Request' },
    );
    expect(store.selectSnapshot(BuilderInvoicesState.listStatus)).toBe('error');
    // Retry (the list error path's Retry button re-dispatches the page).
    store.dispatch(new LoadInvoices(store.selectSnapshot(BuilderInvoicesState.page)));
    expectListRequest(httpMock, '10', '0');
    expect(store.selectSnapshot(BuilderInvoicesState.listStatus)).toBe('ready');
    httpMock.verify();
  });
});

describe('BuilderInvoices ?invoice= deep link', () => {
  it('opens the invoice detail when the invoice query param is present', async () => {
    const { convertToParamMap } = await import('@angular/router');
    const invoices = testInvoices();
    const apiMock = {
      listInvoices: () => of({ invoices, total: null, page: 1, pageSize: 10 }),
      getInvoice: (id: string) => {
        const found = invoices.find((inv) => inv.id === id);
        if (!found) {
          throw new Error(`Test invoice not found: ${id}`);
        }
        return of(found);
      },
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [BuilderInvoicesComponent],
      providers: [
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([BuilderBillingState, BuilderInvoicesState]),
        {
          provide: ConfigService,
          useValue: {
            get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s],
          },
        },
        { provide: BuilderInvoicesApiService, useValue: apiMock },
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap: of(
              convertToParamMap({ invoice: 'inv-test-002' }),
            ),
          },
        },
      ],
    });
    const fixture: ComponentFixture<BuilderInvoicesComponent> =
      TestBed.createComponent(BuilderInvoicesComponent);
    const store = TestBed.inject(Store);
    fixture.detectChanges();
    await flushMock(fixture);

    // The record-contract "View invoice" deep link opens the detail view
    // directly (the paid fixture invoice renders its receipt).
    expect(store.selectSnapshot(BuilderInvoicesState.selected)?.id).toBe(
      'inv-test-002',
    );
    const back = fixture.nativeElement.querySelector(
      '.builder-invoices__back',
    ) as HTMLButtonElement;
    expect(back).not.toBeNull();
  });
});

describe('BuilderInvoices invoice-number column + filter', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  /** Polls the store's committed filter with a deadline (debounce-safe). */
  async function waitForFilter(
    store: Store,
    expected: string,
    timeoutMs = 4000,
  ): Promise<void> {
    // Grace period: don't return before the 400ms debounce has a chance to fire.
    await new Promise((r) => setTimeout(r, 500));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = store.selectSnapshot(
        BuilderInvoicesState.invoiceNumberFilter,
      );
      if (current === expected) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for invoice-number filter ${JSON.stringify(expected)} (got ${JSON.stringify(current)})`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  function filterInput(fixture: ComponentFixture<BuilderInvoicesComponent>) {
    return fixture.nativeElement.querySelector(
      '#invoice-number-filter',
    ) as HTMLInputElement;
  }

  it('renders the invoice number as the first column and row link', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const headers = [
      ...fixture.nativeElement.querySelectorAll(
        '.builder-invoices__table thead th',
      ),
    ].map((th: Element) => th.textContent?.trim());
    expect(headers[0]).toBe('Invoice #');

    const firstRowLink = fixture.nativeElement.querySelector(
      '.builder-invoices__table tbody tr:first-child .builder-invoices__row-link',
    ) as HTMLButtonElement;
    expect(firstRowLink.textContent?.trim()).toBe('INV-0042');

    // Clicking the number opens the detail view.
    firstRowLink.click();
    await flushMock(fixture);
    const { store } = { store: TestBed.inject(Store) };
    expect(store.selectSnapshot(BuilderInvoicesState.selected)?.id).toBe(
      'inv-test-001',
    );
  });

  it('searches by invoice number as you type (debounced)', async () => {
    const { fixture, store } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const input = filterInput(fixture);
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe('e.g. INV-0042');

    input.value = 'inv-0042';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    await waitForFilter(store, 'inv-0042');
  });

  it('clear button empties the search and resets the filter', async () => {
    const { fixture, store } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const input = filterInput(fixture);
    input.value = 'inv-0042';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await waitForFilter(store, 'inv-0042');

    const clear = fixture.nativeElement.querySelector(
      '.builder-invoices__filter-row .builder-invoices__btn',
    ) as HTMLButtonElement;
    expect(clear).not.toBeNull();
    clear.click();
    fixture.detectChanges();

    expect(input.value).toBe('');
    await waitForFilter(store, '');
  });

  it('shows the no-match empty state while a filter is active', async () => {
    const { fixture } = await setupWithInvoices({
      invoices: [],
      total: 0,
      page: 1,
      pageSize: 10,
    });
    fixture.detectChanges();
    await flushMock(fixture);

    // Seed the typed text directly: the empty list + active filter text
    // renders the filter-specific empty state with a clear action.
    const input = filterInput(fixture);
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No invoices match your search.');
  });
});
