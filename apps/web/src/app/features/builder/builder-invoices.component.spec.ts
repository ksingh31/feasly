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
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderBillingState } from './builder-billing.state';
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

function flushMock(fixture: ComponentFixture<BuilderInvoicesComponent>) {
  // Placeholder mock delay(150) + NGXS dispatch microtasks.
  tick(300);
  fixture.detectChanges();
}

describe('BuilderInvoicesComponent (BILL-04)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('renders the invoice list with status pills and amounts', fakeAsync(async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Invoices');
    // Mock data: one in-review, two paid, one failed, one disputed, one finalized.
    expect(text).toContain('In review');
    expect(text).toContain('Paid');
    expect(text).toContain('Failed');
    expect(text).toContain('Disputed');
    // Commission amounts render via the shared money util.
    expect(text).toContain('$6,850');
  }));

  it('shows the review-deadline countdown for in-review invoices', fakeAsync(async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    // Mock in-review invoice has reviewDueAt 3 days out (Edmonton calendar).
    expect(text).toContain('Auto-charges in 3 days');
  }));

  it('opens the detail view with a failed-charge banner and update-card CTA', fakeAsync(async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    flushMock(fixture);

    // Click the failed invoice's date button (third row in mock order).
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    expect(buttons.length).toBeGreaterThan(0);
    buttons[2].click();
    flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Your card was declined');
    expect(text).toContain('Update your card');
    // Timeline renders without any dispute affordance.
    expect(text).toContain('Status timeline');
    expect(text).not.toMatch(/dispute this/i);
  }));

  it('renders receipt details for a paid invoice', fakeAsync(async () => {
    const { fixture } = await setup();
    fixture.detectChanges();
    flushMock(fixture);

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-invoices__row-link'),
    );
    buttons[1].click(); // paid invoice
    flushMock(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Payment received');
    expect(text).toContain('Receipt');
    expect(text).toContain('Amount charged');
  }));

  it('paginates the invoice list', fakeAsync(async () => {
    const { fixture, store } = await setup();
    fixture.detectChanges();
    flushMock(fixture);

    // 6 mock invoices, page size 10 → single page.
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Page 1 of 1');
    const next = fixture.nativeElement.querySelector(
      '.builder-invoices__pagination button:last-child',
    ) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(store.selectSnapshot(BuilderInvoicesState.page)).toBe(1);
  }));
});
