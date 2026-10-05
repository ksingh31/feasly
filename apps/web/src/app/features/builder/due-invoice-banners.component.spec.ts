/**
 * Due-invoice banner component tests.
 *
 * Verifies: the banner set (failed + Edmonton-due-today/overdue in-review,
 * nothing else) drawn from the ACTIONABLE invoice query (every actionable
 * invoice, never just the first page), invoice numbers and amounts in the
 * collapsed bar, expand/collapse per banner, the slim collapse-all summary
 * bar, NGXS-persisted dismissal (a dismissal survives in the store), and
 * the data-driven lifecycle (a paid invoice's banner is gone with no user
 * action).
 *
 * Note: async/await with real timers (not fakeAsync) — zone.js is not
 * installed in this repo, so the fakeAsync helper cannot run here. These
 * tests are fully synchronous: signals recompute on store.reset.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CardOnFileStatus,
  CommissionInvoice,
} from '@feasly/contracts';
import {
  DueInvoiceBannersComponent,
  dueReasonFor,
} from './due-invoice-banners.component';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderBillingState } from './builder-billing.state';
import { BuilderInvoicesState } from './builder-invoices.state';
import { DueInvoiceBannersState } from './due-invoice-banners.state';

const DAY_MS = 86_400_000;
const iso = (t: number): string => new Date(t).toISOString();

function makeInvoice(
  overrides: Partial<CommissionInvoice> & { id: string },
): CommissionInvoice {
  return {
    invoiceNumber: 'INV-0000',
    tenantKey: 't1',
    attributionId: 'a1',
    leadId: 'l1',
    leadName: 'Test Lead',
    contractValueCents: 1_000_000_00,
    commissionCents: 1_000_000,
    currency: 'CAD',
    stripePaymentIntentId: null,
    status: 'in_review',
    reviewDueAt: null,
    finalizedAt: null,
    paidAt: null,
    slaBreached: false,
    disputeReason: null,
    commissionRateOverride: null,
    commissionRatePercent: 1,
    effectiveRatePercent: 1,
    manualPaymentMethod: null,
    paymentReference: null,
    paymentMethod: 'card',
    createdAt: iso(Date.now() - 7 * DAY_MS),
    updatedAt: iso(Date.now() - 7 * DAY_MS),
    ...overrides,
  };
}

const CARD: CardOnFileStatus = {
  hasCard: true,
  brand: 'Visa',
  last4: '4242',
};

function setup(
  invoices: readonly CommissionInvoice[],
  card: CardOnFileStatus | null = CARD,
): { fixture: ComponentFixture<DueInvoiceBannersComponent>; store: Store } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [DueInvoiceBannersComponent],
    providers: [
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
      provideRouter([]),
      provideStore([
        BuilderBillingState,
        BuilderInvoicesState,
        DueInvoiceBannersState,
      ]),
    ],
  });
  const store = TestBed.inject(Store);
  store.reset({
    builderInvoices: {
      invoices: [],
      total: 0,
      page: 1,
      pageSize: 10,
      listStatus: 'idle',
      actionableInvoices: [...invoices],
      actionableStatus: 'ready',
      selected: null,
      detailStatus: 'idle',
      paymentMethodSaveStatus: 'idle',
      invoiceNumberFilter: '',
    },
    builderBilling: { card, cardStatus: 'ready' },
    dueInvoiceBanners: { dismissedIds: [], openIds: [], stackCollapsed: false },
  });
  const fixture = TestBed.createComponent(DueInvoiceBannersComponent);
  fixture.detectChanges();
  return { fixture, store };
}

function bannerBars(fixture: ComponentFixture<DueInvoiceBannersComponent>) {
  return Array.from(
    fixture.nativeElement.querySelectorAll('.due-bar:not(.due-bar--summary)'),
  ) as HTMLElement[];
}

function click(el: HTMLElement, fixture: ComponentFixture<DueInvoiceBannersComponent>) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  fixture.detectChanges();
}

describe('dueReasonFor', () => {
  it('flags failed invoices', () => {
    expect(dueReasonFor(makeInvoice({ id: 'x', status: 'failed' }))).toBe(
      'failed',
    );
  });

  it('flags in-review invoices due today on the Edmonton calendar', () => {
    expect(
      dueReasonFor(
        makeInvoice({
          id: 'x',
          status: 'in_review',
          reviewDueAt: iso(Date.now()),
        }),
      ),
    ).toBe('due-today');
  });

  it('flags in-review invoices past their Edmonton deadline', () => {
    expect(
      dueReasonFor(
        makeInvoice({
          id: 'x',
          status: 'in_review',
          reviewDueAt: iso(Date.now() - 2 * DAY_MS),
        }),
      ),
    ).toBe('overdue');
  });

  it('ignores in-review invoices due in the future', () => {
    expect(
      dueReasonFor(
        makeInvoice({
          id: 'x',
          status: 'in_review',
          reviewDueAt: iso(Date.now() + 3 * DAY_MS),
        }),
      ),
    ).toBeNull();
  });

  it('ignores paid, draft, and disputed invoices', () => {
    for (const status of ['paid', 'draft', 'disputed'] as const) {
      expect(dueReasonFor(makeInvoice({ id: 'x', status }))).toBeNull();
    }
  });

  it('ignores in-review invoices with no deadline', () => {
    expect(
      dueReasonFor(makeInvoice({ id: 'x', status: 'in_review' })),
    ).toBeNull();
  });
});

describe('DueInvoiceBannersComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('renders one banner per due invoice and nothing else', () => {
    const now = Date.now();
    const { fixture } = setup([
      makeInvoice({
        id: 'failed-1',
        invoiceNumber: 'INV-0042',
        status: 'failed',
        reviewDueAt: iso(now - 3 * DAY_MS),
      }),
      makeInvoice({
        id: 'due-today-1',
        invoiceNumber: 'INV-0043',
        status: 'in_review',
        reviewDueAt: iso(now),
      }),
      makeInvoice({
        id: 'future-1',
        invoiceNumber: 'INV-0044',
        status: 'in_review',
        reviewDueAt: iso(now + 3 * DAY_MS),
      }),
      makeInvoice({
        id: 'paid-1',
        invoiceNumber: 'INV-0045',
        status: 'paid',
        reviewDueAt: iso(now - 9 * DAY_MS),
      }),
    ]);
    const bars = bannerBars(fixture);
    expect(bars).toHaveLength(2);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('2 invoices need attention');
    expect(text).toContain('INV-0042');
    expect(text).toContain('INV-0043');
    expect(text).not.toContain('INV-0044');
    expect(text).not.toContain('INV-0045');
  });

  it('shows the failed and due-today bar copy with amounts', () => {
    const now = Date.now();
    const { fixture } = setup([
      makeInvoice({
        id: 'failed-1',
        invoiceNumber: 'INV-0042',
        commissionCents: 1_000_000,
        status: 'failed',
      }),
      makeInvoice({
        id: 'due-today-1',
        invoiceNumber: 'INV-0043',
        commissionCents: 800_000,
        status: 'in_review',
        reviewDueAt: iso(now),
      }),
    ]);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Invoice INV-0042 overdue:');
    expect(text).toContain('$10,000 — payment failed');
    expect(text).toContain('Invoice INV-0043 due today:');
    expect(text).toContain('$8,000 — charges tonight');
  });

  it('renders nothing while the actionable list is loading', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DueInvoiceBannersComponent],
      providers: [
        { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
        provideRouter([]),
        provideStore([
          BuilderBillingState,
          BuilderInvoicesState,
          DueInvoiceBannersState,
        ]),
      ],
    });
    const store = TestBed.inject(Store);
    store.reset({
      builderInvoices: {
        invoices: [],
        total: 0,
        page: 1,
        pageSize: 10,
        listStatus: 'idle',
        actionableInvoices: [],
        actionableStatus: 'loading',
        selected: null,
        detailStatus: 'idle',
        paymentMethodSaveStatus: 'idle',
        invoiceNumberFilter: '',
      },
      builderBilling: { card: null, cardStatus: 'idle' },
      dueInvoiceBanners: { dismissedIds: [], openIds: [], stackCollapsed: false },
    });
    const fixture = TestBed.createComponent(DueInvoiceBannersComponent);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.due-banners'),
    ).toBeNull();
    expect(
      fixture.nativeElement.querySelector('.due-stack-head'),
    ).toBeNull();
  });

  it('expands a banner to the meta line, payment method, and actions', () => {
    const now = Date.now();
    const { fixture } = setup([
      makeInvoice({
        id: 'failed-1',
        invoiceNumber: 'INV-0042',
        leadName: 'Ava Brown',
        contractValueCents: 1_000_000_00,
        status: 'failed',
        reviewDueAt: iso(now - 3 * DAY_MS),
      }),
    ]);
    const bars = bannerBars(fixture);
    expect(bars).toHaveLength(1);
    click(bars[0], fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Invoice INV-0042 ·');
    expect(text).toContain('Ava Brown');
    expect(text).toContain('$1,000,000 contract');
    expect(text).toContain('Payment method: Card •••• 4242');
    expect(text).toContain('(change it on the invoice)');
    // Failed invoices get the card-update CTA plus the invoice link.
    expect(text).toContain('Update card');
    expect(text).toContain('View invoice →');
  });

  it('shows "View invoice" as the primary CTA for due (not failed) invoices', () => {
    const { fixture } = setup([
      makeInvoice({
        id: 'due-today-1',
        invoiceNumber: 'INV-0043',
        status: 'in_review',
        reviewDueAt: iso(Date.now()),
      }),
    ]);
    click(bannerBars(fixture)[0], fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('View invoice');
    expect(text).not.toContain('Update card');
  });

  it('shows the no-card fallback in the payment-method line', () => {
    const { fixture } = setup(
      [
        makeInvoice({
          id: 'due-today-1',
          invoiceNumber: 'INV-0043',
          status: 'in_review',
          reviewDueAt: iso(Date.now()),
        }),
      ],
      null,
    );
    click(bannerBars(fixture)[0], fixture);
    expect(fixture.nativeElement.textContent as string).toContain(
      'Payment method: No card on file',
    );
  });

  it('dismisses one banner for the session via ×', () => {
    const now = Date.now();
    const { fixture } = setup([
      makeInvoice({
        id: 'failed-1',
        invoiceNumber: 'INV-0042',
        status: 'failed',
      }),
      makeInvoice({
        id: 'due-today-1',
        invoiceNumber: 'INV-0043',
        status: 'in_review',
        reviewDueAt: iso(now),
      }),
    ]);
    expect(bannerBars(fixture)).toHaveLength(2);
    const x = fixture.nativeElement.querySelector(
      '.due-bar .due-x',
    ) as HTMLElement;
    click(x, fixture);
    const bars = bannerBars(fixture);
    expect(bars).toHaveLength(1);
    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain('INV-0042');
    expect(text).toContain('INV-0043');
    expect(text).toContain('1 invoice needs attention');
  });

  it('collapses the whole stack into one slim summary bar and back', () => {
    const now = Date.now();
    const { fixture } = setup([
      makeInvoice({ id: 'a', status: 'failed' }),
      makeInvoice({
        id: 'b',
        status: 'in_review',
        reviewDueAt: iso(now),
      }),
    ]);
    const collapseBtn = Array.from(
      fixture.nativeElement.querySelectorAll('.due-stack-head button'),
    ).find((el) => (el as HTMLElement).textContent?.includes('Collapse all'));
    expect(collapseBtn).toBeTruthy();
    click(collapseBtn as HTMLElement, fixture);

    // Slim bar replaces the stack; per-invoice banners are gone.
    expect(bannerBars(fixture)).toHaveLength(0);
    const summary = fixture.nativeElement.querySelector(
      '.due-bar--summary',
    ) as HTMLElement;
    expect(summary).toBeTruthy();
    expect(summary.textContent).toContain('2 invoices need attention');

    // Tapping the summary bar expands the stack again.
    click(summary, fixture);
    expect(bannerBars(fixture)).toHaveLength(2);
  });

  it('dismiss-all from the summary bar clears every banner', () => {
    const now = Date.now();
    const { fixture } = setup([
      makeInvoice({ id: 'a', status: 'failed' }),
      makeInvoice({
        id: 'b',
        status: 'in_review',
        reviewDueAt: iso(now),
      }),
    ]);
    const collapseBtn = Array.from(
      fixture.nativeElement.querySelectorAll('.due-stack-head button'),
    ).find((el) => (el as HTMLElement).textContent?.includes('Collapse all'));
    click(collapseBtn as HTMLElement, fixture);
    const dismissAll = fixture.nativeElement.querySelector(
      '.due-bar--summary .due-x',
    ) as HTMLElement;
    click(dismissAll, fixture);
    expect(
      fixture.nativeElement.querySelector('.due-banners'),
    ).toBeNull();
  });

  it('drops a banner with no user action when its invoice is paid', () => {
    const now = Date.now();
    const failed = makeInvoice({
      id: 'failed-1',
      invoiceNumber: 'INV-0042',
      status: 'failed',
    });
    const due = makeInvoice({
      id: 'due-today-1',
      invoiceNumber: 'INV-0043',
      status: 'in_review',
      reviewDueAt: iso(now),
    });
    const { fixture, store } = setup([failed, due]);
    expect(bannerBars(fixture)).toHaveLength(2);

    // Staff marks the failed invoice paid — the banner set recomputes
    // purely from store state.
    store.reset({
      builderInvoices: {
        invoices: [],
        total: 0,
        page: 1,
        pageSize: 10,
        listStatus: 'idle',
        actionableInvoices: [
          { ...failed, status: 'paid', paidAt: iso(now) },
          due,
        ],
        actionableStatus: 'ready',
        selected: null,
        detailStatus: 'idle',
        paymentMethodSaveStatus: 'idle',
        invoiceNumberFilter: '',
      },
      builderBilling: { card: CARD, cardStatus: 'ready' },
      dueInvoiceBanners: { dismissedIds: [], openIds: [], stackCollapsed: false },
    });
    fixture.detectChanges();

    expect(bannerBars(fixture)).toHaveLength(1);
    expect(fixture.nativeElement.textContent as string).not.toContain(
      'INV-0042',
    );
  });

  it('banners EVERY actionable invoice, not just the first page', () => {
    // Regression: the banner used to read the paginated invoices list
    // (pageSize 10), so actionable invoices past the first page never got
    // a banner. The actionable query returns all of them.
    const now = Date.now();
    const invoices = Array.from({ length: 14 }, (_, i) =>
      makeInvoice({
        id: `failed-${i}`,
        invoiceNumber: `INV-00${40 + i}`,
        status: 'failed',
        reviewDueAt: iso(now - 3 * DAY_MS),
      }),
    );
    const { fixture } = setup(invoices);
    expect(bannerBars(fixture)).toHaveLength(14);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('14 invoices need attention');
    // The 11th+ invoices (past the old page-1 window) are bannered too.
    expect(text).toContain('INV-0050');
    expect(text).toContain('INV-0053');
  });

  it('a dismissal persists in NGXS state (not session-only)', () => {
    const now = Date.now();
    const { fixture, store } = setup([
      makeInvoice({
        id: 'failed-1',
        invoiceNumber: 'INV-0042',
        status: 'failed',
      }),
      makeInvoice({
        id: 'due-today-1',
        invoiceNumber: 'INV-0043',
        status: 'in_review',
        reviewDueAt: iso(now),
      }),
    ]);
    expect(bannerBars(fixture)).toHaveLength(2);
    const x = fixture.nativeElement.querySelector(
      '.due-bar .due-x',
    ) as HTMLElement;
    click(x, fixture);
    expect(bannerBars(fixture)).toHaveLength(1);

    // The dismissal lives in NGXS (storage-plugin persisted), not in a
    // root service's memory.
    expect(
      store.selectSnapshot(DueInvoiceBannersState.dismissedIds),
    ).toContain('failed-1');
  });

});

describe('methodLine (QA 2026-10-04)', () => {
  function expandedMethodText(
    fixture: ComponentFixture<DueInvoiceBannersComponent>,
  ): string {
    const bar = bannerBars(fixture)[0];
    click(bar, fixture);
    const method = fixture.nativeElement.querySelector(
      '.due-body .due-method',
    ) as HTMLElement;
    return method.textContent ?? '';
  }

  it("reads the invoice's own method, not the org card — cheque invoice", () => {
    const { fixture } = setup([
      makeInvoice({ id: 'failed-1', status: 'failed', paymentMethod: 'cheque' }),
    ]);
    expect(expandedMethodText(fixture)).toContain('Payment method: Cheque');
    expect(expandedMethodText(fixture)).not.toContain('4242');
  });

  it('labels a card invoice with the on-file last4', () => {
    const { fixture } = setup([
      makeInvoice({ id: 'failed-1', status: 'failed', paymentMethod: 'card' }),
    ]);
    expect(expandedMethodText(fixture)).toContain(
      'Payment method: Card •••• 4242',
    );
  });

  it('labels a card invoice with no card on file as plain Card', () => {
    const { fixture } = setup(
      [makeInvoice({ id: 'failed-1', status: 'failed', paymentMethod: 'card' })],
      null,
    );
    expect(expandedMethodText(fixture)).toContain('Payment method: Card');
    expect(expandedMethodText(fixture)).not.toContain('••••');
  });

  it('labels an e-transfer invoice with its own method', () => {
    const { fixture } = setup([
      makeInvoice({
        id: 'failed-1',
        status: 'failed',
        paymentMethod: 'e_transfer',
      }),
    ]);
    expect(expandedMethodText(fixture)).toContain('Payment method: E-transfer');
  });
});
