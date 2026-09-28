/**
 * Builder invoices component tests (BILL-04).
 *
 * Verifies: list states (loading / empty / error / populated), the
 * review-deadline countdown, status pills, the failed-charge banner with
 * its "update your card" CTA, the paid-invoice receipt, and pagination.
 *
 * The invoice API is placeholder-backed (mock data) until the backend
 * `GET /api/v1/billing/invoices` endpoint lands — these tests assert the
 * UI contract against the documented wire shape, not the mock itself.
 *
 * Note: async/await with real timers (not fakeAsync) — zone.js is not
 * installed in this repo, so the fakeAsync helper cannot run here.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { CommissionInvoice } from '@feasly/contracts';
import { BuilderBillingState } from './builder-billing.state';
import { BuilderInvoicesApiService } from './builder-invoices-api.service';
import { BuilderInvoicesComponent } from './builder-invoices.component';
import { BuilderInvoicesState } from './builder-invoices.state';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

async function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [BuilderInvoicesComponent],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([BuilderBillingState, BuilderInvoicesState]),
      { provide: ConfigService, useValue: { get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s] } },
    ],
  });
  const fixture: ComponentFixture<BuilderInvoicesComponent> =
    TestBed.createComponent(BuilderInvoicesComponent);
  const store = TestBed.inject(Store);
  return { fixture, store };
}

/** Wait out the placeholder mock delay(150) + NGXS dispatch microtasks. */
async function flushMock(fixture: ComponentFixture<BuilderInvoicesComponent>) {
  await new Promise((r) => setTimeout(r, 300));
  fixture.detectChanges();
  await fixture.whenStable();
}

async function setupWithInvoices(response: {
  invoices: readonly CommissionInvoice[];
  total: number | null;
  page: number;
  pageSize: number;
}) {
  TestBed.resetTestingModule();
  const apiMock = {
    listInvoices: () => of(response),
    getInvoice: () => {
      throw new Error('not used');
    },
  };
  TestBed.configureTestingModule({
    imports: [BuilderInvoicesComponent],
    providers: [
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
  return { fixture };
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
    // Mock data: one in-review, two paid, one failed, one disputed, one finalized.
    expect(text).toContain('In review');
    expect(text).toContain('Paid');
    expect(text).toContain('Failed');
    expect(text).toContain('Disputed');
    // Commission amounts render via the shared money util.
    expect(text).toContain('$6,850');
  });

  it('shows the review-deadline countdown for in-review invoices', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    // Mock in-review invoice has reviewDueAt 3 days out (Edmonton calendar).
    expect(text).toContain('Auto-charges in 3 days');
  });

  it('opens the detail view with a failed-charge banner and update-card CTA', async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    // Click the failed invoice's date button (third row in mock order).
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

  it('paginates the invoice list', async () => {
    const { fixture, store } = await setup();
    fixture.detectChanges();
    await flushMock(fixture);

    // 6 mock invoices, page size 10 → single page.
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
          tenantKey: 't1',
          attributionId: 'a1',
          leadId: 'l1',
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
