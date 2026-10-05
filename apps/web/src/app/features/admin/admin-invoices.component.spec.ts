import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import type { BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import { AdminInvoicesComponent } from './admin-invoices.component';
import { AdminInvoicesState } from './admin-invoices.state';

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

/**
 * AdminInvoicesComponent (QA admin-console fix 3): the admin invoice list
 * with status filter, invoice-number search, pagination, and detail links.
 */
describe('AdminInvoicesComponent', () => {
  let store: Store;
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<AdminInvoicesComponent>;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AdminInvoicesComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ConfigService,
        // AdminInvoicesState lazy-loads at the route in production via
        // lazyProvider; the TestBed registers it directly.
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
    fixture = TestBed.createComponent(AdminInvoicesComponent);
  }

  /** Mounts the page and flushes the initial list load. */
  async function loadPage(
    invoices: BuilderCommissionInvoice[] = [INVOICE_A],
  ): Promise<void> {
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/invoices') && r.method === 'GET')
      .flush(invoices);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function rows(): HTMLElement[] {
    return Array.from(
      fixture.debugElement.queryAll(By.css('.invoices-page__table tbody tr')),
    ).map((row) => row.nativeElement as HTMLElement);
  }

  it('loads on init and renders invoice rows with detail links', async () => {
    await setup();
    await loadPage();

    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent).toContain('Invoices');
    const rowList = rows();
    expect(rowList.length).toBe(1);
    expect(rowList[0].textContent).toContain('INV-0042');
    expect(rowList[0].textContent).toContain('elite-craft');
    expect(rowList[0].textContent).toContain('Ava Smith');
    expect(rowList[0].textContent).toContain('$100');
    expect(rowList[0].textContent).toContain('Paid');
    const link = rowList[0].querySelector(
      'a.invoices-page__link',
    ) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('/admin/billing/invoices/inv-1');
  });

  it('shows the designed empty state when there are no invoices', async () => {
    await setup();
    await loadPage([]);

    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent).toContain('No invoices found');
    expect(rows().length).toBe(0);
  });

  it('styles the filter controls with the console form chrome', async () => {
    await setup();
    await loadPage([]);

    const page = fixture.nativeElement as HTMLElement;
    const select = page.querySelector(
      '.invoices-page__filter select',
    ) as HTMLElement;
    const input = page.querySelector(
      '.invoices-page__filter input',
    ) as HTMLElement;
    expect(select).not.toBeNull();
    expect(input).not.toBeNull();
    // Karan 2026-10-04: the filters rendered as unstyled native controls.
    // The select must carry the shared chevron chrome (feasly-select mixin,
    // like the leads-page filters) and the input the console's bordered
    // card style.
    expect(getComputedStyle(select).appearance).toBe('none');
    expect(getComputedStyle(select).backgroundImage).not.toBe('none');
    expect(getComputedStyle(input).borderTopWidth).toBe('1px');
    expect(getComputedStyle(input).borderTopStyle).toBe('solid');
    expect(getComputedStyle(input).borderRadius).toBe('8px');
  });

  it('shows a retry affordance on load failure', async () => {
    await setup();
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/invoices'))
      .flush('boom', { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    const error = page.querySelector(
      '.invoices-page__state--error',
    ) as HTMLElement;
    expect(error).not.toBeNull();
    expect(error.textContent).toContain('Please try again');
    expect(error.textContent).toContain('Try again');
  });

  it('changing the status filter reloads the list with the status param', async () => {
    await setup();
    await loadPage();

    const select = fixture.debugElement.query(
      By.css('.invoices-page__filter select'),
    ).nativeElement as HTMLSelectElement;
    select.value = 'failed';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const req = httpMock.expectOne(
      (r) => r.url.endsWith('/api/v1/billing/invoices') && r.method === 'GET',
    );
    expect(req.request.params.get('status')).toBe('failed');
    // Filters reset to page 1.
    expect(req.request.params.get('offset')).toBe('0');
    req.flush([]);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(store.selectSnapshot(AdminInvoicesState.page)).toBe(1);
  });

  it('debounced invoice-number search filters the list', async () => {
    await setup();
    await loadPage();

    const input = fixture.debugElement.query(
      By.css('.invoices-page__filter input[type="search"]'),
    ).nativeElement as HTMLInputElement;
    input.value = '42';
    input.dispatchEvent(new Event('input'));
    // Search is debounced (250ms); wait past it in real time.
    await new Promise((resolve) => setTimeout(resolve, 350));
    fixture.detectChanges();

    const req = httpMock.expectOne(
      (r) => r.url.endsWith('/api/v1/billing/invoices') && r.method === 'GET',
    );
    expect(req.request.params.get('invoiceNumber')).toBe('42');
    req.flush([INVOICE_A]);
    await fixture.whenStable();
  });

  it('paginates forward and back', async () => {
    await setup();
    // A full page (20 = pageSize) so Next is enabled.
    const fullPage = Array.from({ length: 20 }, (_, i) => ({
      ...INVOICE_A,
      id: `inv-${i}`,
      invoiceNumber: `INV-00${i}`,
    }));
    await loadPage(fullPage);

    const buttons = () =>
      Array.from(
        fixture.debugElement.queryAll(
          By.css('.invoices-page__pagination button'),
        ),
      ).map((b) => b.nativeElement as HTMLButtonElement);
    const next = buttons().find((b) => b.textContent?.trim() === 'Next')!;
    expect(next.disabled).toBe(false);
    next.click();
    fixture.detectChanges();
    const req = httpMock.expectOne(
      (r) => r.url.endsWith('/api/v1/billing/invoices') && r.method === 'GET',
    );
    expect(req.request.params.get('offset')).toBe('20');
    req.flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(store.selectSnapshot(AdminInvoicesState.page)).toBe(2);
    const prev = buttons().find((b) => b.textContent?.trim() === 'Previous')!;
    expect(prev.disabled).toBe(false);
  });

  it('disables Next when the page is not full', async () => {
    await setup();
    await loadPage([INVOICE_A]);

    const next = Array.from(
      fixture.debugElement.queryAll(
        By.css('.invoices-page__pagination button'),
      ),
    )
      .map((b) => b.nativeElement as HTMLButtonElement)
      .find((b) => b.textContent?.trim() === 'Next')!;
    expect(next.disabled).toBe(true);
  });
});
