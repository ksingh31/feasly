import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { ConfigService } from '../../core/config/config.service';
import type { BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import { AdminInvoiceDetailComponent } from './admin-invoice-detail.component';
import { AdminInvoicesState } from './admin-invoices.state';
import { AdminAuthState } from './admin-auth.state';
import { ADMIN_PERMISSIONS } from './admin-permissions';
import { BillingHealthState } from './billing-health.state';
import { AdminBillingApiService } from './admin-billing-api.service';

const INVOICE_PAID: BuilderCommissionInvoice = {
  id: 'inv-1',
  tenantKey: 'elite-craft',
  attributionId: 'attr-1',
  leadId: 'lead-1',
  leadName: 'Ava Smith',
  contractValueCents: 1_000_000,
  commissionCents: 10_000,
  currency: 'CAD',
  stripePaymentIntentId: 'pi_123',
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

const INVOICE_IN_REVIEW: BuilderCommissionInvoice = {
  ...INVOICE_PAID,
  id: 'inv-2',
  invoiceNumber: 'INV-0043',
  status: 'in_review',
  reviewDueAt: '2026-10-04T12:00:00.000Z',
  finalizedAt: null,
  paidAt: null,
  stripePaymentIntentId: null,
};

/**
 * AdminInvoiceDetailComponent (QA admin-console fix 3): the standalone
 * invoice detail page — full record, Manage action reuse (gated).
 */
describe('AdminInvoiceDetailComponent', () => {
  let store: Store;
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<AdminInvoiceDetailComponent>;

  async function setup(
    invoiceId: string,
    permissions: string[] = [ADMIN_PERMISSIONS.billingManage],
  ): Promise<void> {
    TestBed.resetTestingModule();
    const paramMap = convertToParamMap({ id: invoiceId });
    TestBed.configureTestingModule({
      imports: [AdminInvoiceDetailComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ConfigService,
        { provide: ActivatedRoute, useValue: { paramMap: of(paramMap), snapshot: { paramMap } } },
        // AdminInvoicesState lazy-loads at the route in production via
        // lazyProvider; AdminAuthState is in the root store (app.config.ts).
        // BillingHealthState + a stub billing API back the reused manage
        // modal.
        provideStore([AdminInvoicesState, AdminAuthState, BillingHealthState]),
        {
          provide: AdminBillingApiService,
          useValue: {
            setCommissionRate: vi.fn(),
            markInvoicePaid: vi.fn(),
            setInvoicePaymentMethod: vi.fn(),
          },
        },
      ],
    });
    const config = TestBed.inject(ConfigService);
    const http = TestBed.inject(HttpTestingController);
    const pending = config.load();
    http.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi: false } });
    await pending;
    store = TestBed.inject(Store);
    httpMock = TestBed.inject(HttpTestingController);
    store.reset({
      adminInvoices: store.selectSnapshot((s) => s.adminInvoices),
      billingHealth: store.selectSnapshot((s) => s.billingHealth),
      adminAuth: {
        ...store.selectSnapshot((s) => s.adminAuth),
        permissions,
      },
    });
    fixture = TestBed.createComponent(AdminInvoiceDetailComponent);
  }

  /** Mounts the page and flushes the detail load. */
  async function loadDetail(
    invoice: BuilderCommissionInvoice,
  ): Promise<void> {
    fixture.detectChanges();
    httpMock
      .expectOne(
        (r) =>
          r.url.endsWith(`/api/v1/billing/invoices/${invoice.id}`) &&
          r.method === 'GET',
      )
      .flush(invoice);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('renders the full invoice record', async () => {
    await setup('inv-1');
    await loadDetail(INVOICE_PAID);

    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent).toContain('INV-0042');
    expect(page.textContent).toContain('Paid');
    expect(page.textContent).toContain('elite-craft');
    expect(page.textContent).toContain('Ava Smith');
    expect(page.textContent).toContain('$100'); // commission
    expect(page.textContent).toContain('$10,000'); // contract value
    expect(page.textContent).toContain('1.00%'); // effective rate
    expect(page.textContent).toContain('Card'); // payment method
    expect(page.textContent).toContain('pi_123'); // stripe intent
    expect(page.querySelector('.invoice-detail__breadcrumb')).not.toBeNull();
  });

  it('shows an inline error with retry when the detail load fails', async () => {
    await setup('inv-1');
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/invoices/inv-1'))
      .flush('not found', { status: 404, statusText: 'Not Found' });
    await fixture.whenStable();
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    const error = page.querySelector(
      '.invoice-detail__state--error',
    ) as HTMLElement;
    expect(error).not.toBeNull();
    expect(error.textContent).toContain('Please try again');
    expect(error.textContent).toContain('Try again');
  });

  it('shows the Manage button to billing managers on in-review invoices and opens the modal', async () => {
    await setup('inv-2');
    await loadDetail(INVOICE_IN_REVIEW);

    const manage = fixture.nativeElement.querySelector(
      '.invoice-detail__manage',
    ) as HTMLButtonElement;
    expect(manage).not.toBeNull();
    manage.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelector('.invoice-detail__modal'),
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('app-admin-manage-invoice'),
    ).not.toBeNull();
  });

  it('renders the manage modal above the admin shell chrome', async () => {
    await setup('inv-2');
    await loadDetail(INVOICE_IN_REVIEW);

    const manage = fixture.nativeElement.querySelector(
      '.invoice-detail__manage',
    ) as HTMLButtonElement;
    manage.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const modal = fixture.nativeElement.querySelector(
      '.invoice-detail__modal',
    ) as HTMLElement;
    expect(modal).not.toBeNull();
    // Karan 2026-10-04: the shell nav painted over the dialog — modals must
    // sit above the admin mobile nav dropdown (z-index 100), like the
    // lead-detail and billing modals.
    expect(getComputedStyle(modal).position).toBe('fixed');
    expect(getComputedStyle(modal).zIndex).toBe('150');
  });

  it('hides the Manage button from viewers', async () => {
    await setup('inv-2', []);
    await loadDetail(INVOICE_IN_REVIEW);

    expect(
      fixture.nativeElement.querySelector('.invoice-detail__manage'),
    ).toBeNull();
    // The detail itself stays readable.
    expect(fixture.nativeElement.textContent).toContain('INV-0043');
  });

  it('hides the Manage button on non-actionable statuses (paid)', async () => {
    await setup('inv-1');
    await loadDetail(INVOICE_PAID);

    expect(
      fixture.nativeElement.querySelector('.invoice-detail__manage'),
    ).toBeNull();
  });
});
