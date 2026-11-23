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
import { NEVER, Subject, map, of, throwError, timer } from 'rxjs';
import type { Observable } from 'rxjs';
import type { ConfirmInvoicePaymentResponse, SimulatedIntentResponse } from '@feasly/contracts';
import type { Stripe } from '@stripe/stripe-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiModalService, UiToastService, type UiToastOptions } from '@app/shared/ui';
import { stubObjectUrls } from '../../shared/test-helpers/object-url.stub';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { BuilderBillingApiService } from './builder-billing-api.service';
import { LoadBillingOverview } from './builder-billing.actions';
import { BuilderBillingState } from './builder-billing.state';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderCardModalComponent, STRIPE_LOADER } from './builder-card-modal.component';
import { BuilderInvoiceDrawerComponent } from './builder-invoice-drawer.component';
import { BuilderInvoiceMethodModalComponent } from './builder-invoice-method-modal.component';
import { LoadInvoices, RefreshSelectedInvoice, SelectInvoice } from './builder-invoices.actions';
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
  /** #791: POST confirm-payment answer; when set, the billing API is stubbed. */
  readonly confirm?: () => Observable<ConfirmInvoicePaymentResponse>;
  readonly authenticate?: () => Observable<SimulatedIntentResponse>;
  /** #867: Stripe.js fake handed out by STRIPE_LOADER (null = failed to load). */
  readonly stripe?: { confirmCardPayment: ReturnType<typeof vi.fn> } | null;
  /** #867: billing config overrides (publishable key, poll cadence). */
  readonly billing?: Partial<typeof DEFAULT_APP_CONFIG.billing>;
  /** #901: what POST /invoices/{id}/pay returns. */
  readonly payNow?: () => Observable<BuilderCommissionInvoice>;
}

async function setup(options: Setup = {}) {
  const inv = options.invoice ?? invoice();
  let fail = options.getFails ?? false;
  let current = inv;
  const api = {
    getInvoice: vi.fn(() => (fail ? throwError(() => new Error('boom')) : of(current))),
    listInvoices: vi.fn(() => NEVER),
    payInvoiceNow: vi.fn(options.payNow ?? (() => NEVER)),
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
  const billing = {
    ...DEFAULT_APP_CONFIG.billing,
    questionInvoiceHref: options.questionHref ?? '',
    ...options.billing,
  };
  const loadStripe = vi.fn(async (_key: string) => (options.stripe === undefined ? null : options.stripe) as Stripe | null);
  const billingApi = {
    confirmInvoicePayment: vi.fn(options.confirm ?? (() => NEVER)),
    simulatedAuthenticate: vi.fn(
      options.authenticate ?? (() => of<SimulatedIntentResponse>({ intentId: 'pi_sim_1', status: 'succeeded' })),
    ),
    getOverview: vi.fn(() => NEVER),
    getCard: vi.fn(() => NEVER),
  };
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
      { provide: STRIPE_LOADER, useValue: loadStripe },
      ...(options.confirm ? [{ provide: BuilderBillingApiService, useValue: billingApi }] : []),
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
    billingApi,
    loadStripe,
    succeedNext: () => (fail = false),
    /** #867: what the next GET returns — e.g. the webhook settled it. */
    serverInvoice: (next: BuilderCommissionInvoice) => (current = next),
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

  describe('GST breakdown (#764)', () => {
    const taxed = (patch: Partial<BuilderCommissionInvoice> = {}) =>
      invoice({
        subtotalCents: 685_000,
        taxRatePercent: 5,
        taxInclusive: false,
        taxCents: 34_250,
        totalCents: 719_250,
        taxLabel: 'GST',
        ...patch,
      });

    it('shows subtotal, the "GST (5%)" line and the total, and heads the drawer with the total', async () => {
      const { el } = await setup({ invoice: taxed() });
      expect(el.querySelector('.ui-drawer__title')?.textContent?.trim()).toBe('$7,192.50');
      expect(q(el, 'invoice-subtotal')?.textContent).toContain(T.breakdownSubtotal);
      expect(q(el, 'invoice-subtotal')?.textContent).toContain('$6,850');
      expect(q(el, 'invoice-tax')?.textContent).toContain('GST (5%)');
      expect(q(el, 'invoice-tax')?.textContent).toContain('$342.50');
      expect(q(el, 'invoice-total')?.textContent).toContain(T.breakdownTotal);
      expect(q(el, 'invoice-total')?.textContent).toContain('$7,192.50');
    });

    it('charges the total on a paid taxed invoice receipt', async () => {
      const { el } = await setup({ invoice: taxed({ status: 'paid', paidAt: iso(-1) }) });
      expect(q(el, 'invoice-receipt')?.textContent).toContain('$7,192.50');
    });

    it('AC2: an untaxed invoice (taxCents 0) renders no tax lines — exactly as before', async () => {
      const { el } = await setup({
        invoice: taxed({ taxCents: 0, totalCents: 685_000, taxRatePercent: 0, taxLabel: null }),
      });
      expect(el.querySelector('.ui-drawer__title')?.textContent?.trim()).toBe('$6,850');
      expect(q(el, 'invoice-subtotal')).toBeNull();
      expect(q(el, 'invoice-tax')).toBeNull();
      expect(q(el, 'invoice-total')).toBeNull();
      expect(q(el, 'invoice-breakdown')?.textContent).toContain(T.breakdownCommission);
    });

    it('AC2: hides the tax lines when the tax fields are absent', async () => {
      const { el } = await setup();
      expect(q(el, 'invoice-tax')).toBeNull();
    });
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

  it('#872: shows refunds and the bank-dispute state when present', async () => {
    const { el } = await setup({
      invoice: invoice({ status: 'paid', paidAt: iso(-2), refundedCents: 4_900, chargebackStatus: 'won' }),
    });
    const section = q(el, 'invoice-recovery');
    expect(section?.textContent).toContain(COPY.invoiceDrawer.recoveryHeading);
    expect(q(el, 'invoice-refunded')?.textContent).toContain('$49');
    expect(q(el, 'invoice-chargeback')?.textContent).toContain('Chargeback won');
  });

  it('#862: shows the refund rows, the net paid and the partially refunded badge', async () => {
    const refund = {
      invoiceId: 'inv-1',
      currency: 'CAD',
      note: null,
      method: 'stripe' as const,
      stripeRefundId: null,
      reference: null,
      actorEmail: null,
    };
    const { el } = await setup({
      invoice: invoice({
        status: 'paid',
        paidAt: iso(-2),
        totalCents: 1_980_000,
        refundedCents: 60_050,
        refundState: 'partially_refunded',
        refunds: [
          { ...refund, id: 'rf-1', amountCents: 50_050, reason: 'billing_error', status: 'succeeded', createdAt: '2026-11-15T18:00:00.000Z' },
          { ...refund, id: 'rf-2', amountCents: 10_000, reason: 'goodwill', status: 'pending', createdAt: '2026-11-16T18:00:00.000Z' },
          { ...refund, id: 'rf-3', amountCents: 99_900, reason: 'other', status: 'failed', createdAt: '2026-11-16T19:00:00.000Z' },
        ],
      }),
    });
    expect(q(el, 'invoice-refund-state')?.textContent).toContain('Partially refunded');
    expect(q(el, 'invoice-refunded')?.textContent).toContain('$600.50');
    expect(q(el, 'invoice-net-paid')?.textContent).toContain('$19,199.50');
    const rows = el.querySelectorAll('[data-testid="invoice-refund-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Nov 15, 2026');
    expect(rows[0].textContent).toContain('$500.50');
    expect(rows[0].textContent).toContain(T.refundReasons['billing_error']);
    expect(rows[1].textContent).toContain(T.refundPending);
    expect(el.textContent).not.toContain('$999');
  });

  it('#862: a fully refunded invoice shows the Refunded badge and $0 net paid', async () => {
    const { el } = await setup({
      invoice: invoice({ status: 'paid', paidAt: iso(-2), totalCents: 1_980_000, refundedCents: 1_980_000, refundState: 'refunded' }),
    });
    expect(q(el, 'invoice-refund-state')?.textContent).toContain('Refunded');
    expect(q(el, 'invoice-net-paid')?.textContent).toContain('$0');
  });

  it('#862: no refund badge when nothing was refunded', async () => {
    const { el } = await setup({ invoice: invoice({ status: 'paid', paidAt: iso(-2), refundedCents: 0, refundState: 'none' }) });
    expect(q(el, 'invoice-refund-state')).toBeNull();
    expect(q(el, 'invoice-net-paid')).toBeNull();
  });

  it('#872: hides the refunds section when nothing was refunded or disputed with the bank', async () => {
    const { el } = await setup({ invoice: invoice({ refundedCents: 0, chargebackStatus: null }) });
    expect(q(el, 'invoice-recovery')).toBeNull();
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
    // Undo every stub after each test — even a failing one — so the shared
    // URL global and anchor prototype never leak into other specs (#744).
    const cleanups: Array<() => void> = [];
    afterEach(() => {
      while (cleanups.length) cleanups.pop()!();
    });

    function stubDownload() {
      const urls = stubObjectUrls('blob:invoice');
      const clicked: string[] = [];
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this.download);
      });
      cleanups.push(urls.restore, () => click.mockRestore());
      return { createObjectURL: urls.createObjectURL, revokeObjectURL: urls.revokeObjectURL, clicked };
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
    });

    it('disables the button while the PDF is being prepared', async () => {
      const pending = new Subject<Blob>();
      stubDownload();
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
    });
  });

  describe('confirm payment with your bank (#791, #867)', () => {
    const waiting = () =>
      invoice({ status: 'action_required', reviewDueAt: null, stripePaymentIntentId: 'pi_sim_1' });
    const simConfirm = (): Observable<ConfirmInvoicePaymentResponse> =>
      of({ invoiceId: 'inv-1', paymentIntentId: 'pi_sim_1', clientSecret: 'pi_sim_1_secret_x', provider: 'simulated' });
    const stripeConfirm = (paymentMethodId?: string): (() => Observable<ConfirmInvoicePaymentResponse>) => () =>
      of({
        invoiceId: 'inv-1',
        paymentIntentId: 'pi_1',
        clientSecret: 'pi_1_secret_y',
        provider: 'stripe',
        ...(paymentMethodId ? { paymentMethodId } : {}),
      });
    /** Fast poll so specs settle quickly; the webhook "settles" via serverInvoice(). */
    const fastPoll = { confirmPollIntervalMs: 5, confirmPollAttempts: 400 };
    /** A window that runs out quickly — for the "Check again" path. */
    const shortPoll = { confirmPollIntervalMs: 5, confirmPollAttempts: 3 };
    const stripeBilling = { ...fastPoll, stripePublishableKey: 'pk_test_x' };

    async function settle(fixture: ComponentFixture<BuilderInvoiceDrawerComponent>): Promise<void> {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    /** Polls the DOM until `check` holds or the deadline passes — no fixed sleeps. */
    async function until(
      fixture: ComponentFixture<BuilderInvoiceDrawerComponent>,
      check: () => boolean,
      deadlineMs = 2000,
    ): Promise<void> {
      const end = Date.now() + deadlineMs;
      while (!check()) {
        if (Date.now() > end) throw new Error('condition not met before the deadline');
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        await fixture.whenStable();
        fixture.detectChanges();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    }

    it('shows the primary "Confirm payment with your bank" button and asks nothing until it is clicked', async () => {
      const { el, fixture, billingApi } = await setup({ invoice: waiting(), confirm: simConfirm });
      await settle(fixture);
      expect(q(el, 'invoice-confirm-payment')?.textContent).toContain(COPY.simulated.paymentHeading);
      const cta = q(el, 'invoice-confirm-cta') as HTMLButtonElement;
      expect(cta.textContent?.trim()).toBe(T.confirmPaymentCta);
      expect(cta.getAttribute('variant')).toBeNull();
      expect(billingApi.confirmInvoicePayment).not.toHaveBeenCalled();
    });

    it('shows "Confirming…" and disables the button while confirm-payment is in flight', async () => {
      const { el, fixture } = await setup({ invoice: waiting(), confirm: () => NEVER });
      await settle(fixture);
      q(el, 'invoice-confirm-cta')!.click();
      await settle(fixture);
      const cta = q(el, 'invoice-confirm-cta') as HTMLButtonElement;
      expect(cta.textContent?.trim()).toBe(T.confirmPaymentBusy);
      expect(cta.disabled).toBe(true);
      expect(cta.getAttribute('aria-busy')).toBe('true');
    });

    it('never renders the step when the invoice is not waiting on the bank', async () => {
      const { el, fixture, billingApi } = await setup({ confirm: simConfirm });
      await settle(fixture);
      expect(q(el, 'invoice-confirm-payment')).toBeNull();
      expect(billingApi.confirmInvoicePayment).not.toHaveBeenCalled();
    });

    describe('simulated provider', () => {
      it('offers Complete / Fail for the PaymentIntent after the click (never loads Stripe.js)', async () => {
        const { el, fixture, billingApi, loadStripe } = await setup({ invoice: waiting(), confirm: simConfirm });
        await settle(fixture);
        q(el, 'invoice-confirm-cta')!.click();
        await settle(fixture);
        expect(billingApi.confirmInvoicePayment).toHaveBeenCalledWith('inv-1');
        expect(q(el, 'simulated-challenge')?.textContent).toContain(COPY.simulated.challengeHeading);
        expect(q(el, 'simulated-challenge-complete')).not.toBeNull();
        expect(q(el, 'simulated-challenge-fail')).not.toBeNull();
        expect(q(el, 'invoice-confirm-cta')).toBeNull();
        expect(loadStripe).not.toHaveBeenCalled();
      });

      it('Complete authenticates, toasts, refreshes, shows "Confirming…", and clears once the webhook settles it paid', async () => {
        const { el, fixture, billingApi, toasts, store, serverInvoice } = await setup({
          invoice: waiting(),
          confirm: simConfirm,
          billing: fastPoll,
        });
        await settle(fixture);
        q(el, 'invoice-confirm-cta')!.click();
        await settle(fixture);
        const dispatch = vi.spyOn(store, 'dispatch');
        q(el, 'simulated-challenge-complete')!.click();
        await settle(fixture);
        expect(billingApi.simulatedAuthenticate).toHaveBeenCalledWith({ intentId: 'pi_sim_1', outcome: 'complete' });
        expect(toasts.show).toHaveBeenCalledWith({ message: COPY.simulated.paymentCompletedToast, tone: 'success' });
        expect(dispatch).toHaveBeenCalledWith([
          expect.any(RefreshSelectedInvoice),
          expect.any(LoadInvoices),
          expect.any(LoadBillingOverview),
        ]);
        expect(q(el, 'invoice-confirm-pending')?.textContent).toContain(T.confirmPaymentPending);
        expect(q(el, 'simulated-challenge')).toBeNull();

        serverInvoice(invoice({ status: 'paid', reviewDueAt: null, paidAt: iso(0) }));
        await until(fixture, () => q(el, 'invoice-confirm-payment') === null);
        expect(el.querySelector('ui-status-chip')?.textContent).toContain('Paid');
        expect(q(el, 'invoice-receipt')).not.toBeNull();
      });

      it('Fail authenticates with outcome "fail" and toasts the failed charge — never marks anything paid', async () => {
        const { el, fixture, billingApi, toasts } = await setup({
          invoice: waiting(),
          confirm: simConfirm,
          billing: fastPoll,
          authenticate: () => of({ intentId: 'pi_sim_1', status: 'requires_payment_method' }),
        });
        await settle(fixture);
        q(el, 'invoice-confirm-cta')!.click();
        await settle(fixture);
        q(el, 'simulated-challenge-fail')!.click();
        await settle(fixture);
        expect(billingApi.simulatedAuthenticate).toHaveBeenCalledWith({ intentId: 'pi_sim_1', outcome: 'fail' });
        expect(toasts.show).toHaveBeenCalledWith({ message: COPY.simulated.paymentFailedToast, tone: 'danger' });
        expect(el.querySelector('ui-status-chip')?.textContent).not.toContain('Paid');
      });
    });

    describe('stripe provider', () => {
      it('confirms the PaymentIntent on-session with the saved card, then waits for the webhook', async () => {
        const stripe = { confirmCardPayment: vi.fn(async () => ({ paymentIntent: { status: 'succeeded' } })) };
        const { el, fixture, toasts, loadStripe, serverInvoice } = await setup({
          invoice: waiting(),
          confirm: stripeConfirm('pm_saved'),
          stripe,
          billing: stripeBilling,
        });
        await settle(fixture);
        q(el, 'invoice-confirm-cta')!.click();
        await until(fixture, () => q(el, 'invoice-confirm-pending') !== null);
        expect(loadStripe).toHaveBeenCalledWith('pk_test_x');
        expect(stripe.confirmCardPayment).toHaveBeenCalledWith('pi_1_secret_y', { payment_method: 'pm_saved' });
        expect(toasts.show).toHaveBeenCalledWith({ message: COPY.simulated.paymentCompletedToast, tone: 'success' });
        expect(q(el, 'simulated-challenge')).toBeNull();
        // Still action_required until the webhook lands — never paid client-side.
        expect(el.querySelector('ui-status-chip')?.textContent).not.toContain('Paid');

        serverInvoice(invoice({ status: 'paid', reviewDueAt: null, paidAt: iso(0) }));
        await until(fixture, () => q(el, 'invoice-confirm-payment') === null);
        expect(el.querySelector('ui-status-chip')?.textContent).toContain('Paid');
      });

      it('omits payment_method when the API does not know the saved card', async () => {
        const stripe = { confirmCardPayment: vi.fn(async () => ({ paymentIntent: { status: 'succeeded' } })) };
        const { el, fixture } = await setup({
          invoice: waiting(),
          confirm: stripeConfirm(),
          stripe,
          billing: stripeBilling,
        });
        await settle(fixture);
        q(el, 'invoice-confirm-cta')!.click();
        await until(fixture, () => stripe.confirmCardPayment.mock.calls.length > 0);
        expect(stripe.confirmCardPayment).toHaveBeenCalledWith('pi_1_secret_y', undefined);
      });

      it('a declined / abandoned bank check toasts the failure and lets the webhook move it to failed', async () => {
        const stripe = {
          confirmCardPayment: vi.fn(async () => ({
            error: { type: 'card_error', code: 'payment_intent_authentication_failure' },
          })),
        };
        const { el, fixture, toasts, serverInvoice } = await setup({
          invoice: waiting(),
          confirm: stripeConfirm('pm_saved'),
          stripe,
          billing: stripeBilling,
        });
        await settle(fixture);
        q(el, 'invoice-confirm-cta')!.click();
        await until(fixture, () => q(el, 'invoice-confirm-pending') !== null);
        expect(toasts.show).toHaveBeenCalledWith({ message: COPY.simulated.paymentFailedToast, tone: 'danger' });

        serverInvoice(invoice({ status: 'failed', reviewDueAt: null }));
        await until(fixture, () => q(el, 'invoice-confirm-payment') === null);
        expect(q(el, 'invoice-update-card')).not.toBeNull();
      });

      it('a non-decline Stripe.js error (network / rate limit) shows the retry, not a failed-payment toast', async () => {
        let calls = 0;
        const stripe = {
          confirmCardPayment: vi.fn(async () =>
            ++calls === 1
              ? { error: { type: 'api_connection_error', message: 'offline' } }
              : { paymentIntent: { status: 'succeeded' } },
          ),
        };
        const { el, fixture, toasts } = await setup({
          invoice: waiting(),
          confirm: stripeConfirm('pm_saved'),
          stripe,
          billing: stripeBilling,
        });
        await settle(fixture);
        q(el, 'invoice-confirm-cta')!.click();
        await until(fixture, () => q(el, 'invoice-confirm-error') !== null);
        expect(toasts.show).not.toHaveBeenCalled();
        q(el, 'invoice-confirm-cta')!.click();
        await until(fixture, () => q(el, 'invoice-confirm-pending') !== null);
        expect(stripe.confirmCardPayment).toHaveBeenCalledTimes(2);
        expect(toasts.show).toHaveBeenCalledWith({ message: COPY.simulated.paymentCompletedToast, tone: 'success' });
      });

      it('treats a PaymentIntent back in requires_payment_method as the bank declining', async () => {
        const stripe = {
          confirmCardPayment: vi.fn(async () => ({
            error: { type: 'invalid_request_error', payment_intent: { status: 'requires_payment_method' } },
          })),
        };
        const { el, fixture, toasts } = await setup({
          invoice: waiting(),
          confirm: stripeConfirm('pm_saved'),
          stripe,
          billing: stripeBilling,
        });
        await settle(fixture);
        q(el, 'invoice-confirm-cta')!.click();
        await until(fixture, () => q(el, 'invoice-confirm-pending') !== null);
        expect(toasts.show).toHaveBeenCalledWith({ message: COPY.simulated.paymentFailedToast, tone: 'danger' });
      });

      it('shows an error with a retry when Stripe.js fails to load', async () => {
        const { el, fixture } = await setup({
          invoice: waiting(),
          confirm: stripeConfirm('pm_saved'),
          stripe: null,
          billing: stripeBilling,
        });
        await settle(fixture);
        q(el, 'invoice-confirm-cta')!.click();
        await until(fixture, () => q(el, 'invoice-confirm-error') !== null);
        expect(q(el, 'invoice-confirm-error')?.textContent).toContain(COPY.simulated.paymentLoadError);
        expect(q(el, 'invoice-confirm-cta')).not.toBeNull();
      });

      it('shows an error without a publishable key (never calls Stripe.js)', async () => {
        const stripe = { confirmCardPayment: vi.fn() };
        const { el, fixture, loadStripe } = await setup({
          invoice: waiting(),
          confirm: stripeConfirm('pm_saved'),
          stripe,
          billing: fastPoll,
        });
        await settle(fixture);
        q(el, 'invoice-confirm-cta')!.click();
        await until(fixture, () => q(el, 'invoice-confirm-error') !== null);
        expect(loadStripe).not.toHaveBeenCalled();
        expect(stripe.confirmCardPayment).not.toHaveBeenCalled();
      });
    });

    it('offers a retry when the confirm-payment call fails', async () => {
      let calls = 0;
      const { el, fixture, billingApi } = await setup({
        invoice: waiting(),
        confirm: () => (++calls === 1 ? throwError(() => new Error('boom')) : simConfirm()),
      });
      await settle(fixture);
      q(el, 'invoice-confirm-cta')!.click();
      await settle(fixture);
      expect(q(el, 'invoice-confirm-error')?.textContent).toContain(COPY.simulated.paymentLoadError);
      q(el, 'invoice-confirm-cta')!.click();
      await settle(fixture);
      expect(billingApi.confirmInvoicePayment).toHaveBeenCalledTimes(2);
      expect(q(el, 'simulated-challenge')).not.toBeNull();
    });

    it('offers "Check again" when the webhook has not settled the invoice within the poll window', async () => {
      const { el, fixture, api } = await setup({
        invoice: waiting(),
        confirm: simConfirm,
        billing: shortPoll,
      });
      await settle(fixture);
      q(el, 'invoice-confirm-cta')!.click();
      await settle(fixture);
      q(el, 'simulated-challenge-complete')!.click();
      await until(fixture, () => q(el, 'invoice-confirm-stalled') !== null);
      expect(q(el, 'invoice-confirm-stalled')?.textContent).toContain(T.confirmPaymentStalled);
      const gets = api.getInvoice.mock.calls.length;
      q(el, 'invoice-confirm-check-again')!.click();
      await settle(fixture);
      expect(q(el, 'invoice-confirm-pending')).not.toBeNull();
      await until(fixture, () => api.getInvoice.mock.calls.length > gets);
    });

    it('waits for the last poll to land: settled on the final attempt reloads the list, never shows stalled', async () => {
      const { el, fixture, api } = await setup({
        invoice: waiting(),
        confirm: simConfirm,
        billing: { confirmPollIntervalMs: 5, confirmPollAttempts: 1 },
      });
      await settle(fixture);
      q(el, 'invoice-confirm-cta')!.click();
      await settle(fixture);
      // The webhook lands while the (slow) final poll is in flight.
      const paid = invoice({ status: 'paid', reviewDueAt: null, paidAt: iso(0) });
      api.getInvoice.mockImplementation(() => timer(20).pipe(map(() => paid)));
      q(el, 'simulated-challenge-complete')!.click();
      await settle(fixture);
      const lists = api.listInvoices.mock.calls.length;
      await until(fixture, () => q(el, 'invoice-confirm-payment') === null || q(el, 'invoice-confirm-stalled') !== null);
      expect(q(el, 'invoice-confirm-stalled')).toBeNull();
      await until(fixture, () => api.listInvoices.mock.calls.length > lists);
    });

    it('the stalled state also offers the confirm button again', async () => {
      const { el, fixture, billingApi } = await setup({
        invoice: waiting(),
        confirm: simConfirm,
        billing: shortPoll,
      });
      await settle(fixture);
      q(el, 'invoice-confirm-cta')!.click();
      await settle(fixture);
      q(el, 'simulated-challenge-complete')!.click();
      await until(fixture, () => q(el, 'invoice-confirm-stalled') !== null);
      expect(q(el, 'invoice-confirm-cta')?.textContent).toContain(T.confirmPaymentCta);
      q(el, 'invoice-confirm-cta')!.click();
      await settle(fixture);
      expect(billingApi.confirmInvoicePayment).toHaveBeenCalledTimes(2);
      expect(q(el, 'simulated-challenge')).not.toBeNull();
    });
  });

  describe('Pay now + next retry + overdue (#901)', () => {
    const failedCard = (patch: Partial<BuilderCommissionInvoice> = {}) =>
      invoice({ status: 'failed', reviewDueAt: iso(-2), nextRetryAt: '2026-11-23T15:00:00.000Z', ...patch });

    async function settle(fixture: ComponentFixture<BuilderInvoiceDrawerComponent>): Promise<void> {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    it('shows the next automatic retry date and a Pay now button on a failed card invoice', async () => {
      const { el } = await setup({ invoice: failedCard() });
      expect(q(el, 'invoice-pay-now')).not.toBeNull();
      expect(q(el, 'invoice-next-retry')?.textContent?.trim()).toBe('Nov 23, 2026');
      expect(q(el, 'invoice-pay-now-cta')?.textContent?.trim()).toBe(T.payNowCta);
    });

    it('says no retry is scheduled when the server sends none (paused / cancelled / used up)', async () => {
      const { el } = await setup({ invoice: failedCard({ nextRetryAt: null, dunningState: 'paused' }) });
      expect(q(el, 'invoice-next-retry')?.textContent?.trim()).toBe(T.nextRetryNone);
      // The builder can always pay now, whatever the schedule.
      expect(q(el, 'invoice-pay-now-cta')).not.toBeNull();
    });

    it('never offers Pay now or schedule controls outside a failed card invoice', async () => {
      for (const inv of [invoice(), failedCard({ paymentMethod: 'cheque' }), invoice({ status: 'paid', paidAt: iso(-1) })]) {
        const { el } = await setup({ invoice: inv });
        expect(q(el, 'invoice-pay-now')).toBeNull();
      }
    });

    it('disables the button while the charge is in flight and sends one request on a double click', async () => {
      const reply = new Subject<BuilderCommissionInvoice>();
      const { el, fixture, api } = await setup({ invoice: failedCard(), payNow: () => reply.asObservable() });
      const button = q(el, 'invoice-pay-now-cta') as HTMLButtonElement;
      button.click();
      button.click();
      await settle(fixture);
      const busy = q(el, 'invoice-pay-now-cta') as HTMLButtonElement;
      expect(busy.disabled).toBe(true);
      expect(busy.getAttribute('aria-busy')).toBe('true');
      expect(busy.textContent?.trim()).toBe(T.payNowBusy);
      (busy as HTMLButtonElement).click();
      expect(api.payInvoiceNow).toHaveBeenCalledTimes(1);
      expect(api.payInvoiceNow).toHaveBeenCalledWith('inv-1');
      reply.next(failedCard({ status: 'paid', paidAt: iso(0), nextRetryAt: null }));
      reply.complete();
      await settle(fixture);
      expect(q(el, 'invoice-pay-now')).toBeNull();
    });

    it('a paid result toasts success, swaps the invoice in place and reloads the list + overview', async () => {
      const paid = failedCard({ status: 'paid', paidAt: iso(0), nextRetryAt: null });
      const { el, fixture, toasts, store } = await setup({ invoice: failedCard(), payNow: () => of(paid) });
      const dispatched: unknown[] = [];
      const original = store.dispatch.bind(store);
      vi.spyOn(store, 'dispatch').mockImplementation((a) => {
        dispatched.push(...(Array.isArray(a) ? a : [a]));
        return original(a);
      });
      q(el, 'invoice-pay-now-cta')!.click();
      await settle(fixture);
      expect(toasts.show).toHaveBeenCalledWith({ message: T.payNowPaidToast, tone: 'success' });
      expect(store.selectSnapshot(BuilderInvoicesState.selected)?.status).toBe('paid');
      expect(dispatched.some((a) => a instanceof LoadInvoices)).toBe(true);
      expect(dispatched.some((a) => a instanceof LoadBillingOverview)).toBe(true);
    });

    it('a declined result toasts the decline and keeps Pay now available', async () => {
      const { el, fixture, toasts } = await setup({ invoice: failedCard(), payNow: () => of(failedCard()) });
      q(el, 'invoice-pay-now-cta')!.click();
      await settle(fixture);
      expect(toasts.show).toHaveBeenCalledWith({ message: T.payNowDeclinedToast, tone: 'danger' });
      expect((q(el, 'invoice-pay-now-cta') as HTMLButtonElement).disabled).toBe(false);
    });

    it('a 3D Secure result moves the drawer onto the bank-confirmation step', async () => {
      const { el, fixture, toasts } = await setup({
        invoice: failedCard(),
        payNow: () => of(failedCard({ status: 'action_required', nextRetryAt: null })),
      });
      q(el, 'invoice-pay-now-cta')!.click();
      await settle(fixture);
      expect(toasts.show).toHaveBeenCalledWith({ message: T.payNowConfirmToast });
      expect(q(el, 'invoice-confirm-payment')).not.toBeNull();
      expect(q(el, 'invoice-pay-now')).toBeNull();
    });

    it('a failed request shows an inline error and re-enables the button', async () => {
      const { el, fixture, toasts } = await setup({
        invoice: failedCard(),
        payNow: () => throwError(() => new Error('boom')),
      });
      q(el, 'invoice-pay-now-cta')!.click();
      await settle(fixture);
      expect(q(el, 'invoice-pay-now-error')?.textContent?.trim()).toBe(T.payNowError);
      expect((q(el, 'invoice-pay-now-cta') as HTMLButtonElement).disabled).toBe(false);
      expect(toasts.show).not.toHaveBeenCalled();
    });

    it('a manual-method invoice past its due date shows as overdue', async () => {
      const { el } = await setup({
        invoice: invoice({ paymentMethod: 'cheque', dueAt: '2026-11-10T07:00:00.000Z', overdueDays: 6 }),
      });
      expect(q(el, 'invoice-overdue')?.textContent?.trim()).toBe(
        'This invoice was due Nov 10, 2026 and is 6 days overdue.',
      );
    });

    it('shows no overdue banner before the due date or for a card invoice', async () => {
      const notYet = await setup({ invoice: invoice({ paymentMethod: 'cheque', dueAt: iso(3), overdueDays: 0 }) });
      expect(q(notYet.el, 'invoice-overdue')).toBeNull();
      const card = await setup({ invoice: invoice({ dueAt: null, overdueDays: 4 }) });
      expect(q(card.el, 'invoice-overdue')).toBeNull();
    });
  });
});
