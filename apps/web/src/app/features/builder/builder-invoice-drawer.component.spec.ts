/**
 * Builder invoice drawer (#533): header (amount, chip, countdown),
 * lifecycle stepper, contract × rate = commission breakdown, payment
 * method with a "Change" link that opens the before/after modal, a
 * timeline sorted by timestamp, receipt, and actions.
 */
import { DIALOG_DATA } from '@angular/cdk/dialog';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { UiModalService, UiToastService, type UiToastOptions } from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { BuilderBillingState } from './builder-billing.state';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderCardModalComponent } from './builder-card-modal.component';
import { BuilderInvoiceDrawerComponent } from './builder-invoice-drawer.component';
import { BuilderInvoiceMethodModalComponent } from './builder-invoice-method-modal.component';
import { SelectInvoice } from './builder-invoices.actions';
import { BuilderInvoicesApiService, type BuilderCommissionInvoice } from './builder-invoices-api.service';
import { BuilderInvoicesState } from './builder-invoices.state';
import type { BuilderPaymentMethod } from './builder-payment-methods';

const COPY = DEFAULT_BUILDER_COPY;
const T = COPY.invoiceDrawer;
const DAY = 86_400_000;
const iso = (offsetDays: number): string => new Date(Date.now() + offsetDays * DAY).toISOString();

function invoice(patch: Partial<BuilderCommissionInvoice> = {}): BuilderCommissionInvoice {
  return {
    id: 'inv-1',
    tenantKey: 't1',
    attributionId: 'a1',
    leadId: 'l1',
    leadName: 'Ava Brown',
    contractValueCents: 68_500_000,
    commissionCents: 685_000,
    currency: 'CAD',
    stripePaymentIntentId: null,
    status: 'in_review',
    reviewDueAt: iso(3),
    finalizedAt: null,
    paidAt: null,
    slaBreached: false,
    disputeReason: null,
    commissionRateOverride: null,
    commissionRatePercent: 1,
    effectiveRatePercent: 1,
    manualPaymentMethod: null,
    paymentReference: null,
    createdAt: iso(-4),
    updatedAt: iso(-4),
    invoiceNumber: 'INV-0042',
    paymentMethod: 'card',
    ...patch,
  } as BuilderCommissionInvoice;
}

interface Setup {
  readonly invoice?: BuilderCommissionInvoice;
  readonly getFails?: boolean;
  readonly questionHref?: string;
  /** #661: what the PDF download returns. */
  readonly pdf?: Subject<Blob> | 'ok' | 'fail';
}

async function setup(options: Setup = {}) {
  const inv = options.invoice ?? invoice();
  let fail = options.getFails ?? false;
  const api = {
    getInvoice: vi.fn(() => (fail ? throwError(() => new Error('boom')) : of(inv))),
    downloadInvoicePdf: vi.fn(() => {
      const pdf = options.pdf ?? 'ok';
      if (pdf === 'ok') return of(new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
      if (pdf === 'fail') return throwError(() => new Error('pdf failed'));
      return pdf.asObservable();
    }),
  };
  const modalClosed = new Subject<BuilderPaymentMethod | undefined>();
  const modals = { open: vi.fn(() => ({ closed: modalClosed.asObservable() })) };
  const toasts = {
    show: vi.fn((_o: UiToastOptions) => ({ id: 1, dismissed: of('manual' as const), dismiss: vi.fn() })),
  };
  const billing = { ...DEFAULT_APP_CONFIG.billing, questionInvoiceHref: options.questionHref ?? '' };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [BuilderInvoiceDrawerComponent],
    providers: [
      { provide: BUILDER_COPY, useValue: COPY },
      { provide: DIALOG_DATA, useValue: { invoiceId: inv.id } },
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([BuilderBillingState, BuilderInvoicesState]),
      {
        provide: ConfigService,
        useValue: {
          get: (s: keyof typeof DEFAULT_APP_CONFIG) => (s === 'billing' ? billing : DEFAULT_APP_CONFIG[s]),
        },
      },
      { provide: BuilderInvoicesApiService, useValue: api },
      { provide: UiModalService, useValue: modals },
      { provide: UiToastService, useValue: toasts },
    ],
  });
  const store = TestBed.inject(Store);
  await new Promise<void>((resolve) => store.dispatch(new SelectInvoice(inv.id)).subscribe({ complete: resolve }));
  const fixture: ComponentFixture<BuilderInvoiceDrawerComponent> = TestBed.createComponent(BuilderInvoiceDrawerComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    el,
    store,
    api,
    modals,
    modalClosed,
    toasts,
    succeedNext: () => (fail = false),
  };
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('BuilderInvoiceDrawerComponent (#533)', () => {
  it('heads the drawer with the amount, status chip, number · lead and the countdown', async () => {
    const { el } = await setup();
    expect(el.querySelector('.ui-drawer__title')?.textContent?.trim()).toBe('$6,850');
    expect(el.querySelector('ui-status-chip')?.textContent).toContain('In review');
    expect(q(el, 'invoice-meta')?.textContent).toContain('INV-0042 · Ava Brown');
    expect(q(el, 'invoice-countdown')?.textContent?.trim()).toBe('Auto-charges in 3 days');
  });

  it('shows "Due in X days" for a manual method (never auto-charges)', async () => {
    const { el } = await setup({ invoice: invoice({ paymentMethod: 'cheque' }) });
    expect(q(el, 'invoice-countdown')?.textContent?.trim()).toBe('Due in 3 days');
  });

  it('renders the lifecycle stepper at the review window', async () => {
    const { el } = await setup();
    const stepper = el.querySelector('ui-stepper') as HTMLElement;
    expect(stepper).not.toBeNull();
    expect(stepper.textContent).toContain('Review window');
  });

  it('breaks the commission down as contract × rate = commission (server figures)', async () => {
    const { el } = await setup({ invoice: invoice({ effectiveRatePercent: 2, commissionCents: 1_370_000 }) });
    const rows = q(el, 'invoice-breakdown')!.textContent ?? '';
    expect(rows).toContain(COPY.invoicesContractRow);
    expect(rows).toContain('$685,000');
    expect(rows).toContain('× 2%');
    expect(rows).toContain('$13,700');
    expect(q(el, 'invoice-formula')?.textContent?.trim()).toBe('$685,000 × 2% = $13,700');
  });

  it('omits the formula (no invented rate) when the server sends no rate', async () => {
    const { el } = await setup({ invoice: invoice({ effectiveRatePercent: undefined, commissionRatePercent: null }) });
    expect(q(el, 'invoice-breakdown')?.textContent).toContain('× —');
    expect(q(el, 'invoice-formula')).toBeNull();
  });

  it('AC1: sorts the timeline by timestamp even when the charge failed before finalize', async () => {
    const { el } = await setup({
      invoice: invoice({
        status: 'failed',
        createdAt: '2026-10-28T16:00:00.000Z',
        reviewDueAt: '2026-11-04T16:00:00.000Z',
        updatedAt: '2026-11-04T18:00:00.000Z',
        finalizedAt: '2026-11-05T18:00:00.000Z',
      }),
    });
    const titles = Array.from(q(el, 'invoice-timeline')!.querySelectorAll('.timeline__title')).map((n) =>
      n.textContent?.trim(),
    );
    expect(titles).toEqual([
      COPY.invoicesTimelineCreated,
      COPY.invoicesTimelineReviewEnds,
      COPY.invoicesTimelineFailed,
      COPY.invoicesTimelineFinalized,
    ]);
  });

  it('shows the declined banner and an update-card action for a failed charge', async () => {
    const { el } = await setup({ invoice: invoice({ status: 'failed', finalizedAt: iso(-1), updatedAt: iso(-1) }) });
    expect(el.textContent).toContain('Your card was declined');
    // The action opens the shared Stripe card modal in place (#534), not a page link.
    const open = vi.spyOn(TestBed.inject(UiModalService), 'open').mockReturnValue({} as never);
    (q(el, 'invoice-update-card') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith(BuilderCardModalComponent, expect.objectContaining({ size: 'sm' }));
    expect(el.textContent).not.toMatch(/dispute this/i);
  });

  it('renders the receipt and locks the method for a paid invoice', async () => {
    const { el } = await setup({
      invoice: invoice({ status: 'paid', paidAt: iso(-2), finalizedAt: iso(-2), reviewDueAt: iso(-9) }),
    });
    expect(el.textContent).toContain('Payment received');
    expect(q(el, 'invoice-receipt')?.textContent).toContain(COPY.invoicesReceiptAmount);
    expect(q(el, 'invoice-change-method')).toBeNull();
    expect(q(el, 'invoice-method-note')?.textContent).toContain(COPY.invoicesPaymentMethodLocked);
  });

  it('locks the method for a disputed invoice', async () => {
    const { el } = await setup({ invoice: invoice({ status: 'disputed' }) });
    expect(q(el, 'invoice-change-method')).toBeNull();
    expect(q(el, 'invoice-method-note')?.textContent).toContain(COPY.invoicesPaymentMethodLocked);
  });

  it('describes what the saved method does (card in review → the approved charge-timing sentence)', async () => {
    const { el } = await setup();
    expect(q(el, 'invoice-method')?.textContent?.trim()).toBe('Card');
    expect(q(el, 'invoice-method-note')?.textContent).toContain(
      'We charge your card 7 days after the invoice is issued. You can question it any time before then.',
    );
  });

  it('AC2: "Change" opens the payment-method modal (no inline select / Apply)', async () => {
    const { el, modals } = await setup();
    expect(el.querySelector('select')).toBeNull();
    expect(el.textContent).not.toContain(COPY.invoicesPaymentMethodApply);
    const change = q(el, 'invoice-change-method') as HTMLButtonElement;
    expect(change.textContent?.trim()).toBe(T.changeMethod);
    expect(change.getAttribute('aria-label')).toBe('Change payment method for INV-0042');
    change.click();
    expect(modals.open).toHaveBeenCalledTimes(1);
    const [component, options] = modals.open.mock.calls[0] as unknown as [unknown, { data: { invoice: { id: string } } }];
    expect(component).toBe(BuilderInvoiceMethodModalComponent);
    expect(options.data.invoice.id).toBe('inv-1');
  });

  it('toasts after the modal saves a new method; nothing on cancel', async () => {
    const { el, modalClosed, toasts } = await setup();
    (q(el, 'invoice-change-method') as HTMLButtonElement).click();
    modalClosed.next(undefined);
    expect(toasts.show).not.toHaveBeenCalled();
    (q(el, 'invoice-change-method') as HTMLButtonElement).click();
    modalClosed.next('cheque');
    expect(toasts.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Payment method changed to Cheque.', tone: 'success' }),
    );
  });

  it('links "Question this invoice" when configured', async () => {
    const { el } = await setup({ questionHref: 'mailto:billing@example.com' });
    expect((q(el, 'invoice-question') as HTMLAnchorElement).getAttribute('href')).toBe('mailto:billing@example.com');
  });

  it('hides "Question this invoice" when unconfigured', async () => {
    const { el } = await setup();
    expect(q(el, 'invoice-question')).toBeNull();
  });

  it('shows an error with Retry when the invoice fails to load', async () => {
    const { el, fixture, api, succeedNext } = await setup({ getFails: true });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(COPY.invoicesLoadError);
    expect(el.querySelector('.ui-drawer__title')?.textContent?.trim()).toBe(T.loadingHeading);
    succeedNext();
    (el.querySelector('.invoice-drawer__error button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(api.getInvoice).toHaveBeenCalledTimes(2);
    expect(el.querySelector('.ui-drawer__title')?.textContent?.trim()).toBe('$6,850');
  });

  describe('Download PDF (#661)', () => {
    function stubDownload() {
      const createObjectURL = vi.fn(() => 'blob:invoice');
      const revokeObjectURL = vi.fn();
      // defineProperty, not assign: another spec may have left these
      // non-writable (still configurable) on the shared URL global.
      Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true });
      Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true, writable: true });
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this.download);
      });
      const clicked: string[] = [];
      return { createObjectURL, revokeObjectURL, click, clicked };
    }

    it('offers "Download PDF" for every invoice, named for the invoice', async () => {
      for (const status of ['in_review', 'paid', 'failed', 'void'] as const) {
        const { el } = await setup({ invoice: invoice({ status }) });
        const btn = q(el, 'invoice-download-pdf') as HTMLButtonElement;
        expect(btn.textContent?.trim()).toBe(T.downloadPdf);
        expect(btn.getAttribute('aria-label')).toBe('Download PDF of invoice INV-0042');
      }
    });

    it('fetches the server PDF and saves it as feasly-<number>.pdf', async () => {
      const dl = stubDownload();
      const { el, api, fixture } = await setup({ invoice: invoice({ status: 'paid', paidAt: iso(-1) }) });
      (q(el, 'invoice-download-pdf') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(api.downloadInvoicePdf).toHaveBeenCalledWith('inv-1');
      expect(dl.createObjectURL).toHaveBeenCalledTimes(1);
      expect(dl.clicked).toEqual(['feasly-INV-0042.pdf']);
      expect(q(el, 'invoice-download-error')).toBeNull();
      dl.click.mockRestore();
    });

    it('disables the button while the PDF is being prepared', async () => {
      const pending = new Subject<Blob>();
      const dl = stubDownload();
      const { el, api, fixture } = await setup({ pdf: pending });
      const btn = q(el, 'invoice-download-pdf') as HTMLButtonElement;
      btn.click();
      fixture.detectChanges();
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('aria-busy')).toBe('true');
      expect(btn.textContent?.trim()).toBe(T.downloadingPdf);
      btn.click();
      expect(api.downloadInvoicePdf).toHaveBeenCalledTimes(1);
      pending.next(new Blob(['%PDF']));
      pending.complete();
      fixture.detectChanges();
      expect(btn.disabled).toBe(false);
      expect(btn.textContent?.trim()).toBe(T.downloadPdf);
      dl.click.mockRestore();
    });

    it('shows an inline error when the download fails, and clears it on retry', async () => {
      const dl = stubDownload();
      const { el, fixture, api } = await setup({ pdf: 'fail' });
      (q(el, 'invoice-download-pdf') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(q(el, 'invoice-download-error')?.textContent).toContain(T.downloadPdfError);
      expect(dl.clicked).toEqual([]);
      api.downloadInvoicePdf.mockReturnValueOnce(of(new Blob(['%PDF'])));
      (q(el, 'invoice-download-pdf') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(q(el, 'invoice-download-error')).toBeNull();
      expect(dl.clicked).toEqual(['feasly-INV-0042.pdf']);
      dl.click.mockRestore();
    });
  });
});
