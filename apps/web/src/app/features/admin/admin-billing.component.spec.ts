import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Subject, of, throwError } from 'rxjs';
import type { BillingHealthResponse, Builder } from '@feasly/contracts';
import { UiConfirmService, type UiConfirmOptions, UiDrawerService, UiModalService, UiToastService } from '@app/shared/ui';
import { AdminBillingApiService } from './admin-billing-api.service';
import { AdminBuildersApiService } from './admin-builders-api.service';
import { BuilderInvoicesApiService } from '../builder/builder-invoices-api.service';
import { AdminDisputesApiService } from './admin-disputes-api.service';
import { BillingHealthState } from './billing-health.state';
import { AdminBuildersState } from './admin-builders.state';
import { AdminInvoicesState } from './admin-invoices.state';
import { AdminAuthState } from './admin-auth.state';
import { AdminBillingComponent } from './admin-billing.component';
import { AdminCreateInvoiceComponent } from './admin-create-invoice.component';
import { AdminInvoiceDrawerComponent } from './admin-invoice-drawer.component';
import { AdminInvoicePaymentModalComponent } from './admin-invoice-payment-modal.component';
import { ADMIN_PERMISSIONS } from './admin-permissions';

const HEALTH: BillingHealthResponse = {
  model: 'commission',
  stripe: { configured: true, testMode: true },
  generatedAt: '2026-09-26T12:00:00.000Z',
  mrr: { cents: null, currency: 'CAD', activeSubscriptions: 0, source: 'not_applicable' },
  collectedTrailing30d: { count: 2, commissionCents: 50_000 },
  inReview: {
    under48h: { count: 1, commissionCents: 10_000 },
    under7d: { count: 0, commissionCents: 0 },
    overdue: { count: 1, commissionCents: 30_000 },
  },
  disputed: { count: 0, commissionCents: 0 },
  dunning: [
    {
      id: 'inv-1',
      tenantKey: 'test-builder',
      commissionCents: 15_000,
      currency: 'CAD',
      commissionRatePercent: 1,
      contractValueCents: 1_500_000,
      paymentMethod: 'card',
      pastDueSince: '2026-09-24T12:00:00.000Z',
      retryCount: 1,
      lastFailureReason: 'Your card was declined.',
    },
  ],
  inReviewInvoices: [
    {
      id: 'inv-2',
      tenantKey: 'test-builder',
      commissionCents: 10_000,
      currency: 'CAD',
      reviewDueAt: '2026-10-03T12:00:00.000Z',
      commissionRatePercent: 1.5,
      contractValueCents: 1_000_000,
      paymentMethod: 'cheque',
    },
  ],
  maxChargeRetries: 3,
  webhooks: {
    received24h: 3,
    lastReceivedAt: '2026-09-26T10:00:00.000Z',
    byType24h: [{ type: 'payment_intent.succeeded', count: 3 }],
    unhandled24h: 0,
    modelMismatch24h: 1,
  },
};

const BUILDERS = [
  {
    id: 'b-1',
    tenantKey: 'test-builder',
    displayName: 'Test Builder',
    businessName: 'Test Builder Inc.',
    commissionRatePercent: 1,
  } as Builder,
];

const INVOICE_DETAIL = {
  id: 'inv-2',
  tenantKey: 'test-builder',
  invoiceNumber: 'INV-0002',
  commissionCents: 10_000,
  contractValueCents: 1_000_000,
  status: 'in_review',
  paymentMethod: 'cheque',
};

async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Harness {
  fixture: ComponentFixture<AdminBillingComponent>;
  store: Store;
  el: HTMLElement;
  api: { getBillingHealth: ReturnType<typeof vi.fn>; retryInvoiceCharge: ReturnType<typeof vi.fn> };
  confirms: { confirm: ReturnType<typeof vi.fn>; answer: Subject<boolean> };
  modals: { open: ReturnType<typeof vi.fn> };
  drawers: { open: ReturnType<typeof vi.fn>; openDrawer: null };
  toasts: { show: ReturnType<typeof vi.fn> };
  invoicesApi: { getInvoice: ReturnType<typeof vi.fn> };
}

async function setup(opts: { health?: BillingHealthResponse; permissions?: string[] } = {}): Promise<Harness> {
  TestBed.resetTestingModule();
  const api = {
    getBillingHealth: vi.fn().mockReturnValue(of(opts.health ?? HEALTH)),
    retryInvoiceCharge: vi.fn().mockReturnValue(of({ invoiceId: 'inv-1', status: 'finalized', retryCount: 2 })),
  };
  const answer = new Subject<boolean>();
  const confirms = { confirm: vi.fn(() => answer.asObservable()), answer };
  const modals = { open: vi.fn(() => ({ closed: of(false) })) };
  const drawers = { open: vi.fn(), openDrawer: null };
  const toasts = { show: vi.fn() };
  const invoicesApi = { getInvoice: vi.fn(() => of(INVOICE_DETAIL)) };
  await TestBed.configureTestingModule({
    imports: [AdminBillingComponent],
    providers: [
      provideRouter([]),
      provideStore([BillingHealthState, AdminAuthState, AdminBuildersState, AdminInvoicesState]),
      { provide: AdminBillingApiService, useValue: api },
      { provide: AdminBuildersApiService, useValue: { listBuilders: vi.fn(() => of({ builders: BUILDERS })) } },
      { provide: BuilderInvoicesApiService, useValue: invoicesApi },
      { provide: AdminDisputesApiService, useValue: {} },
      { provide: UiConfirmService, useValue: confirms },
      { provide: UiModalService, useValue: modals },
      { provide: UiDrawerService, useValue: drawers },
      { provide: UiToastService, useValue: toasts },
    ],
  }).compileComponents();
  const store = TestBed.inject(Store);
  store.reset({
    ...store.snapshot(),
    adminAuth: {
      ...store.selectSnapshot((s) => s.adminAuth),
      permissions: opts.permissions ?? [ADMIN_PERMISSIONS.billingManage],
    },
  });
  const fixture = TestBed.createComponent(AdminBillingComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, store, el, api, confirms, modals, drawers, toasts, invoicesApi };
}

function q(el: HTMLElement, id: string): HTMLElement | null {
  return el.querySelector(`[data-testid="${id}"]`);
}

function buttonLabels(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim());
}

/** Opens a row's ⋮ menu and picks an action by its id. */
async function pickRowAction(h: Harness, queue: string, action: string): Promise<void> {
  const trigger = h.el.querySelector(`[data-testid="${queue}"] .row-actions__trigger`) as HTMLButtonElement;
  expect(trigger).not.toBeNull();
  trigger.click();
  await h.fixture.whenStable();
  const item = document.querySelector(`.row-actions__item[data-action="${action}"]`) as HTMLButtonElement;
  expect(item).not.toBeNull();
  item.click();
  await h.fixture.whenStable();
}

describe('AdminBillingComponent (#544 Billing overview)', () => {
  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => (el.innerHTML = ''));
  });

  it('renders the kit header with environment chips, KPIs and both queues', async () => {
    const { el } = await setup();
    expect(el.querySelector('h1')?.textContent).toContain('Billing');
    expect(q(el, 'billing-model-chip')?.textContent).toContain('Commission');
    expect(q(el, 'stripe-mode-chip')?.textContent).toContain('Stripe test mode');
    // Chips are status, not buttons (review S9).
    expect(q(el, 'stripe-mode-chip')?.querySelector('button')).toBeNull();
    const text = el.textContent ?? '';
    expect(text).toContain('Not used under the commission model');
    expect(text).toContain('$500');
    expect(text).toContain('needs attention');
    // Builder names, not tenant keys, once builders load.
    expect(q(el, 'in-review-queue')?.textContent).toContain('Test Builder');
    expect(q(el, 'in-review-queue')?.textContent).toContain('1.5%');
    expect(q(el, 'in-review-queue')?.textContent).toContain('Cheque');
    expect(q(el, 'dunning-queue')?.textContent).toContain('$150');
    expect(q(el, 'dunning-queue')?.textContent).toContain('1 of 3');
    expect(q(el, 'dunning-queue')?.textContent).toContain('Your card was declined.');
  });

  it('moves webhook detail off the page and links to Webhooks', async () => {
    const { el } = await setup();
    expect(el.textContent).not.toContain('payment_intent.succeeded');
    expect(q(el, 'webhooks-link')?.getAttribute('href')).toBe('/admin/webhooks');
    expect(el.textContent).toContain('Webhooks need attention');
  });

  it('flags live and unconfigured Stripe in the header chip', async () => {
    let h = await setup({ health: { ...HEALTH, stripe: { configured: true, testMode: false } } });
    expect(q(h.el, 'stripe-mode-chip')?.textContent).toContain('Stripe live');
    h = await setup({ health: { ...HEALTH, stripe: { configured: false, testMode: false } } });
    expect(q(h.el, 'stripe-mode-chip')?.textContent).toContain('Stripe not configured');
  });

  it('renders the empty dunning state when the queue is clear', async () => {
    const { el } = await setup({ health: { ...HEALTH, dunning: [] } });
    expect(q(el, 'dunning-queue')?.textContent).toContain('No failed charges');
  });

  it('shows an error state with Retry on load failure', async () => {
    TestBed.resetTestingModule();
    const h = await setup();
    h.store.reset({ ...h.store.snapshot(), billingHealth: { ...h.store.snapshot().billingHealth, health: null } });
    h.api.getBillingHealth.mockReturnValue(throwError(() => new Error('network down')));
    (q(h.el, 'refresh-billing') as HTMLButtonElement).click();
    await h.fixture.whenStable();
    expect(h.el.textContent).toContain("Couldn't load billing");
    expect(buttonLabels(h.el)).toContain('Retry');
  });

  it('opens the invoice drawer in place from a row and from Manage', async () => {
    const h = await setup();
    (h.el.querySelector('[data-testid="in-review-queue"] [data-testid="manage-invoice"]') as HTMLButtonElement).click();
    expect(h.drawers.open).toHaveBeenCalledWith(
      AdminInvoiceDrawerComponent,
      expect.objectContaining({ data: { invoiceId: 'inv-2' }, urlId: 'inv-2' }),
    );
    const row = h.el.querySelector('[data-testid="dunning-queue"] tbody tr') as HTMLElement;
    row.click();
    expect(h.drawers.open).toHaveBeenLastCalledWith(
      AdminInvoiceDrawerComponent,
      expect.objectContaining({ data: { invoiceId: 'inv-1' } }),
    );
  });

  describe('retry charge (AC1)', () => {
    it('confirms with the amount and builder before dispatching', async () => {
      const h = await setup();
      await pickRowAction(h, 'dunning-queue', 'retry');
      await until(() => h.confirms.confirm.mock.calls.length === 1, 'confirm opened');
      const options = h.confirms.confirm.mock.calls[0][0] as UiConfirmOptions;
      expect(options.title).toContain('Test Builder');
      expect(options.title).toContain('$150');
      expect(options.body).toContain('$150');
      expect(options.body).toContain('retry 2 of 3');
      expect(options.verb).toBe('Retry charge');
      // Nothing is charged until the verb is pressed.
      expect(h.api.retryInvoiceCharge).not.toHaveBeenCalled();
      h.confirms.answer.next(true);
      h.confirms.answer.complete();
      await h.fixture.whenStable();
      expect(h.api.retryInvoiceCharge).toHaveBeenCalledWith('inv-1');
      expect(h.toasts.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('Charge re-attempted'), tone: 'success' }),
      );
    });

    it('does nothing when the confirm is cancelled', async () => {
      const h = await setup();
      await pickRowAction(h, 'dunning-queue', 'retry');
      await until(() => h.confirms.confirm.mock.calls.length === 1, 'confirm opened');
      h.confirms.answer.next(false);
      h.confirms.answer.complete();
      await h.fixture.whenStable();
      expect(h.api.retryInvoiceCharge).not.toHaveBeenCalled();
    });

    it('disables retry once retries are exhausted', async () => {
      const h = await setup({ health: { ...HEALTH, dunning: [{ ...HEALTH.dunning[0], retryCount: 3 }] } });
      const trigger = h.el.querySelector('[data-testid="dunning-queue"] .row-actions__trigger') as HTMLButtonElement;
      trigger.click();
      await h.fixture.whenStable();
      const retry = document.querySelector('.row-actions__item[data-action="retry"]') as HTMLButtonElement;
      expect(retry.getAttribute('aria-disabled')).toBe('true');
      expect(retry.textContent).toContain('All retries used');
    });
  });

  it('records a payment from the queue through the payment modal (AC1)', async () => {
    const h = await setup();
    await pickRowAction(h, 'in-review-queue', 'record-payment');
    await until(() => h.modals.open.mock.calls.length === 1, 'payment modal opened');
    expect(h.invoicesApi.getInvoice).toHaveBeenCalledWith('inv-2');
    expect(h.modals.open).toHaveBeenCalledWith(
      AdminInvoicePaymentModalComponent,
      expect.objectContaining({ data: { invoice: expect.objectContaining({ id: 'inv-2' }) } }),
    );
  });

  it('opens the create-invoice modal from the header (AC2)', async () => {
    const h = await setup();
    (q(h.el, 'open-create-invoice') as HTMLButtonElement).click();
    expect(h.modals.open).toHaveBeenCalledWith(AdminCreateInvoiceComponent, expect.anything());
    // No inline form pushes the page down any more.
    expect(h.el.querySelector('app-admin-create-invoice')).toBeNull();
  });

  describe('viewer permission gating', () => {
    it('shows the write UI to billing managers', async () => {
      const { el } = await setup();
      expect(buttonLabels(el)).toContain('Create invoice');
      expect(buttonLabels(el)).toContain('Manage');
      expect(el.querySelectorAll('.row-actions__trigger').length).toBeGreaterThan(0);
    });

    it('hides every write action from viewers but keeps the read-only data', async () => {
      const { el } = await setup({ permissions: [] });
      const labels = buttonLabels(el);
      expect(labels).not.toContain('Create invoice');
      expect(labels).not.toContain('Manage');
      expect(labels).toContain('Details');
      expect(el.querySelectorAll('.row-actions__trigger').length).toBe(0);
      expect(el.textContent).toContain('Test Builder');
    });
  });
});

/**
 * Regression guard for the 2026-09-27 incident: the production root store
 * does NOT hold BillingHealthState — the admin/billing route lazy-registers
 * it (and, since #544, AdminInvoicesState for the in-place drawer).
 */
describe('AdminBillingComponent route-level state registration', () => {
  async function render(withRouteProviders: boolean) {
    TestBed.resetTestingModule();
    const { billingHealthStateProvider } = await import('./billing-health.state');
    const { adminInvoicesStateProvider } = await import('./admin-invoices.state');
    const { adminBuildersStateProvider } = await import('./admin-builders.state');
    await TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        provideRouter([]),
        provideStore([AdminAuthState]),
        // The parent /admin route registers AdminBuildersState.
        adminBuildersStateProvider,
        ...(withRouteProviders ? [billingHealthStateProvider, adminInvoicesStateProvider] : []),
        { provide: AdminBillingApiService, useValue: { getBillingHealth: vi.fn(() => of(HEALTH)) } },
        { provide: AdminBuildersApiService, useValue: { listBuilders: vi.fn(() => of({ builders: BUILDERS })) } },
      ],
    }).compileComponents();
    return TestBed.createComponent(AdminBillingComponent);
  }

  it('reproduces the production crash when the route provider is missing', async () => {
    const fixture = await render(false);
    expect(() => fixture.detectChanges()).toThrow();
  });

  it('initializes cleanly with the route-level providers', async () => {
    const fixture = await render(true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Billing');
  });
});
