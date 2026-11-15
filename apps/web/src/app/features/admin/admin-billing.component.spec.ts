import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { BillingHealthResponse } from '@feasly/contracts';
import { AdminBillingApiService } from './admin-billing-api.service';
import { BillingHealthState } from './billing-health.state';
import { AdminAuthState } from './admin-auth.state';
import { AdminBillingComponent } from './admin-billing.component';
import { ADMIN_PERMISSIONS } from './admin-permissions';

const HEALTH: BillingHealthResponse = {
  model: 'commission',
  stripe: { configured: true, testMode: true },
  generatedAt: '2026-09-26T12:00:00.000Z',
  mrr: {
    cents: null,
    currency: 'CAD',
    activeSubscriptions: 0,
    source: 'not_applicable',
  },
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
      commissionRatePercent: 1,
      contractValueCents: 1_000_000,
      paymentMethod: 'card',
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

describe('AdminBillingComponent (billing/03)', () => {
  let fixture: ComponentFixture<AdminBillingComponent>;
  let store: Store;

  /** Grants the session every permission the billing write UI needs. */
  function grantBillingManage(): void {
    store.reset({
      billingHealth: store.selectSnapshot((s) => s.billingHealth),
      adminAuth: {
        ...store.selectSnapshot((s) => s.adminAuth),
        permissions: [ADMIN_PERMISSIONS.billingManage],
      },
    });
  }

  beforeEach(async () => {
    const api = {
      getBillingHealth: vi.fn().mockReturnValue(of(HEALTH)),
      retryInvoiceCharge: vi.fn().mockReturnValue(
        of({ invoiceId: 'inv-1', status: 'finalized', retryCount: 2 }),
      ),
    };
    await TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        provideRouter([]),
        provideStore([BillingHealthState, AdminAuthState]),
        { provide: AdminBillingApiService, useValue: api },
      ],
    }).compileComponents();
    store = TestBed.inject(Store);
    // Existing tests assert the full write UI — the session manages billing.
    grantBillingManage();
    fixture = TestBed.createComponent(AdminBillingComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('loads billing health on init and renders the panels', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Billing health');
    expect(text).toContain('Commission');
    expect(text).toContain('Stripe test mode');
    // MRR is n/a under the commission model.
    expect(text).toContain('n/a under the commission model');
    // Collected trailing 30d.
    expect(text).toContain('$500');
    // Overdue bucket flags attention.
    expect(text).toContain('needs attention');
    // Dunning row.
    expect(text).toContain('test-builder');
    expect(text).toContain('$150');
    // Webhook health.
    expect(text).toContain('payment_intent.succeeded');
  });

  it('renders an empty dunning state when the queue is clear', async () => {
    const api = TestBed.inject(AdminBillingApiService) as unknown as {
      getBillingHealth: ReturnType<typeof vi.fn>;
    };
    api.getBillingHealth.mockReturnValue(of({ ...HEALTH, dunning: [] }));
    const refreshButton = fixture.nativeElement.querySelector(
      '.billing-panel__refresh',
    ) as HTMLButtonElement;
    refreshButton.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('dunning queue is clear');
  });

  it('shows a retry affordance on load failure', async () => {
    const api = TestBed.inject(AdminBillingApiService) as unknown as {
      getBillingHealth: ReturnType<typeof vi.fn>;
    };
    const { throwError } = await import('rxjs');
    api.getBillingHealth.mockReturnValue(
      throwError(() => new Error('network down')),
    );
    const refreshButton = fixture.nativeElement.querySelector(
      '.billing-panel__refresh',
    ) as HTMLButtonElement;
    refreshButton.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Could not load billing health');
    expect(text).toContain('Retry');
  });

  it('renders retry count, failure reason, and a Retry 2 of 3 button per failed invoice', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('1 of 3');
    expect(text).toContain('Your card was declined.');
    expect(text).toContain('Retry 2 of 3');
  });

  it('requires a confirm click before dispatching the retry', async () => {
    const api = TestBed.inject(AdminBillingApiService) as unknown as {
      retryInvoiceCharge: ReturnType<typeof vi.fn>;
    };
    const retryButton = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ).find((b) => (b as HTMLButtonElement).textContent?.includes('Retry 2 of 3'));
    expect(retryButton).toBeDefined();
    (retryButton as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    // First click only arms the confirm state — no API call yet.
    expect(api.retryInvoiceCharge).not.toHaveBeenCalled();
    const confirmButton = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ).find((b) => (b as HTMLButtonElement).textContent?.includes('Confirm retry'));
    expect(confirmButton).toBeDefined();
    (confirmButton as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(api.retryInvoiceCharge).toHaveBeenCalledWith('inv-1');
    // Durable success feedback.
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Charge re-attempted');
  });

  it('renders the in-review work queue with a Manage action per invoice', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('In-review invoices');
    expect(text).toContain('Manage');
    // The work-queue row shows the effective rate.
    expect(text).toContain('1%');
  });

  it('links Manage to the invoice drawer on the Invoices page (#543)', () => {
    const links = Array.from(
      fixture.nativeElement.querySelectorAll('a.billing-panel__link'),
    ) as HTMLAnchorElement[];
    const manage = links.filter((a) => a.textContent?.trim() === 'Manage');
    expect(manage.length).toBeGreaterThan(0);
    expect(manage[0].getAttribute('href')).toContain('/admin/billing/invoices?open=');
    // The old in-page manage modal is gone.
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
  });

  describe('viewer permission gating (QA admin-console finding 8)', () => {
    /** Re-renders the page with a read-only session (no permissions). */
    async function renderAsViewer(): Promise<void> {
      store.reset({
        billingHealth: store.selectSnapshot((s) => s.billingHealth),
        adminAuth: {
          ...store.selectSnapshot((s) => s.adminAuth),
          permissions: [],
        },
      });
      fixture.detectChanges();
      await fixture.whenStable();
    }

    function buttonLabels(): string[] {
      return Array.from(fixture.nativeElement.querySelectorAll('button')).map(
        (b) => ((b as HTMLButtonElement).textContent ?? '').trim(),
      );
    }

    function linkLabels(): string[] {
      return Array.from(fixture.nativeElement.querySelectorAll('a.billing-panel__link')).map(
        (a) => ((a as HTMLAnchorElement).textContent ?? '').trim(),
      );
    }

    it('shows the write UI to billing managers', () => {
      const labels = buttonLabels();
      expect(labels).toContain('Create invoice');
      expect(linkLabels()).toContain('Manage');
      expect(labels.some((l) => l.startsWith('Retry'))).toBe(true);
    });

    it('hides every write action from viewers but keeps the read-only data', async () => {
      await renderAsViewer();
      const labels = buttonLabels();
      expect(labels).not.toContain('Create invoice');
      expect(linkLabels()).not.toContain('Manage');
      expect(linkLabels()).toContain('Details');
      expect(labels.some((l) => l.startsWith('Retry'))).toBe(false);
      // The money overview itself stays visible.
      const text = fixture.nativeElement.textContent as string;
      expect(text).toContain('Billing health');
      expect(text).toContain('test-builder');
      // Details links are read-only and stay available to viewers.
      expect(
        fixture.nativeElement.querySelectorAll('a.billing-panel__link').length,
      ).toBeGreaterThan(0);
    });
  });

  it('shows manual handling when retries are exhausted', async () => {
    TestBed.resetTestingModule();
    const exhausted = {
      ...HEALTH,
      dunning: [
        { ...HEALTH.dunning[0], retryCount: 3 },
      ],
    };
    const api = {
      getBillingHealth: vi.fn().mockReturnValue(of(exhausted)),
      retryInvoiceCharge: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        provideRouter([]),
        provideStore([BillingHealthState, AdminAuthState]),
        { provide: AdminBillingApiService, useValue: api },
      ],
    }).compileComponents();
    // The retry queue is a billing:manage write surface.
    const store2 = TestBed.inject(Store);
    store2.reset({
      billingHealth: store2.selectSnapshot((s) => s.billingHealth),
      adminAuth: {
        ...store2.selectSnapshot((s) => s.adminAuth),
        permissions: [ADMIN_PERMISSIONS.billingManage],
      },
    });
    const f2 = TestBed.createComponent(AdminBillingComponent);
    f2.detectChanges();
    await f2.whenStable();
    const text = f2.nativeElement.textContent as string;
    expect(text).toContain('Manual handling');
    expect(text).not.toContain('Retry charge');
  });
});

/**
 * Regression guard for the 2026-09-27 incident: the component's own spec
 * provided BillingHealthState directly in its TestBed, masking the fact that
 * the state was never registered in production — so /admin/billing crashed
 * at init. These tests simulate the production route setup: the root store
 * WITHOUT the state, plus the route-level billingHealthStateProvider that
 * lazyProvider installs.
 */
describe('AdminBillingComponent route-level state registration', () => {
  async function setup(withRouteProvider: boolean) {
    TestBed.resetTestingModule();
    const api = {
      getBillingHealth: vi.fn().mockReturnValue(of(HEALTH)),
      retryInvoiceCharge: vi.fn(),
    };
    const { billingHealthStateProvider } = await import('./billing-health.state');
    await TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        provideRouter([]),
        // Production root store: BillingHealthState is NOT here (it is
        // lazy-loaded at the admin/billing route); AdminAuthState IS in
        // the root store (app.config.ts).
        provideStore([AdminAuthState]),
        ...(withRouteProvider ? [billingHealthStateProvider] : []),
        { provide: AdminBillingApiService, useValue: api },
      ],
    }).compileComponents();
  }

  it('reproduces the production crash when the route provider is missing', async () => {
    await setup(false);
    const fixture = TestBed.createComponent(AdminBillingComponent);
    // selectSignal throws lazily when the template reads the signal during
    // change detection — exactly the production crash path.
    expect(() => fixture.detectChanges()).toThrow();
  });

  it('initializes cleanly with the route-level billingHealthStateProvider', async () => {
    await setup(true);
    const fixture = TestBed.createComponent(AdminBillingComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Billing health');
  });
});
