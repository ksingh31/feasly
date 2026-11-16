/**
 * Builder Money page (#532) tests.
 *
 * AC1 status labels come from the shared status dictionary; AC2 exactly
 * one, owner-approved charge-timing sentence and no contradicting copy;
 * AC3 the invoice table uses the kit DataTable (card list below 768px)
 * with the lifecycle stepper. Plus KPI formatting, card panel, the
 * config-driven "Question an invoice" link and load-error retry.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuilderBillingOverviewResponse } from '@feasly/contracts';
import { STATUS_DICTIONARY, UiModalService } from '@app/shared/ui';
import { BuilderCardModalComponent } from './builder-card-modal.component';
import { BuilderMoneyComponent, buildKpis, cardExpiry } from './builder-money.component';
import { BUILDER_COPY } from './builder-copy';
import { CHARGE_TIMING_COPY, DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderBillingState } from './builder-billing.state';
import { BuilderInvoicesState } from './builder-invoices.state';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { SeoService } from '../../core/seo/seo.service';

const OVERVIEW: BuilderBillingOverviewResponse = {
  planType: 'commission',
  commissionRatePercent: 1,
  currency: 'CAD',
  outstandingCents: 5_415_000,
  outstandingCount: 3,
  nextCharge: {
    invoiceId: 'i1',
    invoiceNumber: 'FEAS-2026-0104',
    amountCents: 1_980_000,
    chargeAt: '2026-11-19T18:00:00Z',
    cardLast4: '4242',
  },
  failedCount: 1,
  failedInvoices: [{ id: 'i3', invoiceNumber: 'FEAS-2026-0103', leadId: 'l3', commissionCents: 875_000 }],
  disputedCount: 0,
  card: { hasCard: true, brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028 },
};

function invoice(id: string, status: string, n: number) {
  return {
    id,
    tenantKey: 't',
    attributionId: 'a',
    leadId: `l-${id}`,
    leadName: `Lead ${n}`,
    contractValueCents: 100_000_000,
    commissionCents: 1_000_000,
    currency: 'CAD',
    stripePaymentIntentId: null,
    status,
    reviewDueAt: '2026-11-19T18:00:00Z',
    finalizedAt: null,
    paidAt: null,
    slaBreached: false,
    disputeReason: null,
    commissionRateOverride: null,
    commissionRatePercent: 1,
    createdAt: '2026-11-12T18:00:00Z',
    invoiceNumber: `FEAS-2026-010${n}`,
    paymentMethod: 'card',
  };
}

const INVOICES = [
  invoice('i1', 'in_review', 4),
  invoice('i2', 'paid', 2),
  invoice('i3', 'failed', 3),
  invoice('i4', 'disputed', 1),
];

async function setup(questionInvoiceHref = '') {
  TestBed.resetTestingModule();
  const configStub = {
    get: (section: keyof typeof DEFAULT_APP_CONFIG) =>
      section === 'billing'
        ? { ...DEFAULT_APP_CONFIG.billing, questionInvoiceHref }
        : DEFAULT_APP_CONFIG[section],
  } as unknown as ConfigService;
  TestBed.configureTestingModule({
    imports: [BuilderMoneyComponent],
    providers: [
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
      { provide: ConfigService, useValue: configStub },
      { provide: SeoService, useValue: { setPage: vi.fn() } },
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([BuilderBillingState, BuilderInvoicesState]),
    ],
  });
  const fixture: ComponentFixture<BuilderMoneyComponent> = TestBed.createComponent(BuilderMoneyComponent);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  return { fixture, http, el: fixture.nativeElement as HTMLElement };
}

function flushAll(
  http: HttpTestingController,
  overview: BuilderBillingOverviewResponse = OVERVIEW,
  invoices: readonly unknown[] = INVOICES,
) {
  http.expectOne((r) => r.url.endsWith('/api/v1/builder/billing/overview')).flush(overview);
  http.expectOne((r) => r.url.endsWith('/api/v1/billing/invoices')).flush(invoices);
}

async function render(fixture: ComponentFixture<BuilderMoneyComponent>) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('BuilderMoneyComponent (#532)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the four KPI tiles from the overview', async () => {
    const { fixture, http, el } = await setup();
    flushAll(http);
    await render(fixture);
    const tiles = Array.from(el.querySelectorAll('ui-kpi-tile'));
    expect(tiles.map((t) => t.getAttribute('data-kpi'))).toEqual(['outstanding', 'next', 'failed', 'plan']);
    const text = el.textContent ?? '';
    expect(text).toContain('$54,150');
    expect(text).toContain('Across 3 unpaid invoices');
    expect(text).toContain('$19,800');
    expect(text).toContain('Nov 19, 2026 · card •••• 4242');
    expect(text).toContain('1% commission');
  });

  it('AC1: invoice status chips use the shared status dictionary labels', async () => {
    const { fixture, http, el } = await setup();
    flushAll(http);
    await render(fixture);
    const chips = Array.from(el.querySelectorAll('ui-status-chip')).map((c) => c.textContent?.trim());
    for (const status of ['in_review', 'paid', 'failed', 'disputed'] as const) {
      expect(chips).toContain(STATUS_DICTIONARY.invoice[status].label);
    }
    // Never the raw enum.
    expect(chips).not.toContain('in_review');
  });

  it('shows the invoice lifecycle stepper per row', async () => {
    const { fixture, http, el } = await setup();
    flushAll(http);
    await render(fixture);
    const steppers = el.querySelectorAll('table ui-stepper');
    expect(steppers.length).toBe(INVOICES.length);
    const first = steppers[0];
    expect(first.querySelector('ol')?.getAttribute('aria-label')).toBe('Invoice progress');
    expect(first.querySelector('[aria-current="step"]')?.textContent).toContain('Review window');
    const failed = steppers[2];
    expect(failed.querySelector('[aria-current="step"]')?.textContent).toContain('Charge failed');
  });

  it('AC3: renders through the kit DataTable, whose card list serves phones', async () => {
    const { fixture, http, el } = await setup();
    flushAll(http);
    await render(fixture);
    const table = el.querySelector('ui-data-table')!;
    expect(table).not.toBeNull();
    const cards = table.querySelectorAll('.ui-dt__card');
    expect(cards.length).toBe(INVOICES.length);
    // Card: invoice number title + status chip; the stepper column stays off the card.
    expect(cards[0].querySelector('.ui-dt__card-title')?.textContent).toContain('FEAS-2026-0104');
    expect(cards[0].querySelector('ui-status-chip')?.textContent?.trim()).toBe('In review');
    expect(cards[0].querySelector('ui-stepper')).toBeNull();
  });

  it('AC2: shows the owner-approved charge-timing sentence exactly once', async () => {
    const { fixture, http, el } = await setup();
    flushAll(http);
    await render(fixture);
    const text = el.textContent ?? '';
    expect(text.split(CHARGE_TIMING_COPY).length - 1).toBe(1);
    // None of the retired, contradicting phrasings (#479).
    expect(text).not.toMatch(/7 days later|after each review window|overdue/i);
  });

  it('AC2: no builder copy contradicts the approved charge timing', () => {
    const values = Object.values(DEFAULT_BUILDER_COPY).filter((v): v is string => typeof v === 'string');
    for (const v of values) {
      expect(v).not.toMatch(/auto-charges 7 days later|7 days after each review window/i);
    }
  });

  it('opens the invoice detail on row click', async () => {
    const { fixture, http, el } = await setup();
    flushAll(http);
    await render(fixture);
    const router = TestBed.inject(Router);
    const nav = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    (el.querySelector('table tbody tr') as HTMLElement).click();
    expect(nav).toHaveBeenCalledWith(['/builder/invoices'], { queryParams: { invoice: 'i1' } });
  });

  it('renders the card panel with brand, last4 and MM/YY expiry', async () => {
    const { fixture, http, el } = await setup();
    flushAll(http);
    await render(fixture);
    const text = el.textContent ?? '';
    expect(text).toContain('Visa •••• 4242');
    expect(text).toContain('Expires 08/28');
    expect(el.querySelector('a[href="/builder/billing"]')).toBeNull();
    expect(el.querySelector('.money__card-action')?.textContent).toContain('Update card');
  });

  it('opens the card modal from the card panel with the saved card (#534)', async () => {
    const { fixture, http, el } = await setup();
    flushAll(http);
    await render(fixture);
    const open = vi.spyOn(TestBed.inject(UiModalService), 'open').mockReturnValue({} as never);
    (el.querySelector('.money__card-action') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith(
      BuilderCardModalComponent,
      expect.objectContaining({ data: { card: OVERVIEW.card }, size: 'sm', dismissOnScrim: false }),
    );
  });

  it('offers "Add a card" when none is saved', async () => {
    const { fixture, http, el } = await setup();
    flushAll(http, { ...OVERVIEW, card: { hasCard: false }, nextCharge: null });
    await render(fixture);
    const text = el.textContent ?? '';
    expect(text).toContain('No card on file yet.');
    expect(text).toContain('Add a card');
    expect(text).toContain('None scheduled');
  });

  it('hides "Question an invoice" until a destination is configured', async () => {
    const { fixture, http, el } = await setup();
    flushAll(http);
    await render(fixture);
    expect(el.textContent).not.toContain('Question an invoice');
  });

  it('links "Question an invoice" to the configured destination', async () => {
    const { fixture, http, el } = await setup('mailto:billing@example.test');
    flushAll(http);
    await render(fixture);
    const link = Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.includes('Question an invoice'));
    expect(link?.getAttribute('href')).toBe('mailto:billing@example.test');
  });

  it('shows an error state with Retry when the overview fails, and retries', async () => {
    const { fixture, http, el } = await setup();
    http
      .expectOne((r) => r.url.endsWith('/api/v1/builder/billing/overview'))
      .flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
    http.expectOne((r) => r.url.endsWith('/api/v1/billing/invoices')).flush(INVOICES);
    await render(fixture);
    expect(el.textContent).toContain(DEFAULT_BUILDER_COPY.moneyLoadError);
    const retry = Array.from(el.querySelectorAll('ui-error-state button')).find((b) =>
      b.textContent?.includes(DEFAULT_BUILDER_COPY.retryLabel),
    ) as HTMLButtonElement;
    retry.click();
    http.expectOne((r) => r.url.endsWith('/api/v1/builder/billing/overview')).flush(OVERVIEW);
    await render(fixture);
    expect(el.querySelectorAll('ui-kpi-tile').length).toBe(4);
  });

  it('shows the empty state when there are no invoices', async () => {
    const { fixture, http, el } = await setup();
    flushAll(http, OVERVIEW, []);
    await render(fixture);
    expect(el.textContent).toContain(DEFAULT_BUILDER_COPY.moneyInvoicesEmptyHeading);
  });
});

describe('buildKpis', () => {
  it('formats a flat plan and singular counts', () => {
    const kpis = buildKpis(
      { ...OVERVIEW, planType: 'flat', commissionRatePercent: null, outstandingCount: 1, failedCount: 0, card: null },
      DEFAULT_BUILDER_COPY,
    );
    expect(kpis.find((k) => k.key === 'plan')?.value).toBe('Flat subscription');
    expect(kpis.find((k) => k.key === 'outstanding')?.sub).toBe('Across 1 unpaid invoice');
    const failed = kpis.find((k) => k.key === 'failed')!;
    expect(failed.tone).toBeUndefined();
    expect(failed.link).toBeUndefined();
  });

  it('links the failed tile to the card page with a danger tone', () => {
    const failed = buildKpis(OVERVIEW, DEFAULT_BUILDER_COPY).find((k) => k.key === 'failed')!;
    expect(failed.tone).toBe('danger');
    expect(failed.link).toBe('/builder/billing');
  });

  it('notes a scheduled charge with no card saved', () => {
    const next = buildKpis(
      { ...OVERVIEW, nextCharge: { ...OVERVIEW.nextCharge!, cardLast4: null } },
      DEFAULT_BUILDER_COPY,
    ).find((k) => k.key === 'next')!;
    expect(next.sub).toBe('Nov 19, 2026 · no card on file');
  });

  it('#764: labels the tax-inclusive amounts when sales tax is on', () => {
    const kpis = buildKpis(
      { ...OVERVIEW, tax: { ratePercent: 5, label: 'GST', inclusive: false } },
      DEFAULT_BUILDER_COPY,
    );
    expect(kpis.find((k) => k.key === 'outstanding')?.label).toBe('Outstanding (incl. GST)');
    expect(kpis.find((k) => k.key === 'next')?.label).toBe('Next charge (incl. GST)');
    expect(kpis.find((k) => k.key === 'failed')?.label).toBe(DEFAULT_BUILDER_COPY.moneyKpiFailed);
  });

  it('#764 AC2: labels stay unchanged without tax', () => {
    const kpis = buildKpis(OVERVIEW, DEFAULT_BUILDER_COPY);
    expect(kpis.find((k) => k.key === 'outstanding')?.label).toBe('Outstanding');
    expect(kpis.find((k) => k.key === 'next')?.label).toBe('Next charge');
  });
});

describe('cardExpiry', () => {
  it('pads to MM/YY and handles missing parts', () => {
    expect(cardExpiry({ hasCard: true, expMonth: 8, expYear: 2028 })).toBe('08/28');
    expect(cardExpiry({ hasCard: true, expMonth: 12 })).toBeNull();
    expect(cardExpiry(null)).toBeNull();
  });
});
