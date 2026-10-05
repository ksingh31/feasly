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

  it('opens the manage modal from an in-review Manage button and closes it', async () => {
    const manageButton = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ).find((b) => (b as HTMLButtonElement).textContent?.trim() === 'Manage');
    expect(manageButton).toBeDefined();
    (manageButton as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    let modal = fixture.nativeElement.querySelector('app-admin-manage-invoice');
    expect(modal).not.toBeNull();
    expect(modal.textContent).toContain('Record payment');
    // Close via the modal's Close button.
    const closeButton = Array.from(modal.querySelectorAll('button')).find(
      (b) => (b as HTMLButtonElement).textContent?.trim() === 'Close',
    ) as HTMLButtonElement;
    expect(closeButton).toBeDefined();
    closeButton.click();
    fixture.detectChanges();
    await fixture.whenStable();
    modal = fixture.nativeElement.querySelector('app-admin-manage-invoice');
    expect(modal).toBeNull();
  });

  it('renders the manage modal with a dialog shell, backdrop close, and Esc close', async () => {
    const manageButton = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ).find((b) => (b as HTMLButtonElement).textContent?.trim() === 'Manage');
    (manageButton as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    const modal = fixture.nativeElement.querySelector('.billing-modal');
    expect(modal).not.toBeNull();
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    // Backdrop click closes the modal.
    (
      modal.querySelector('.billing-modal__backdrop') as HTMLElement
    ).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.billing-modal')).toBeNull();
    // Re-open, then Esc closes it.
    (manageButton as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    const reopened = fixture.nativeElement.querySelector('.billing-modal');
    expect(reopened).not.toBeNull();
    reopened.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.billing-modal')).toBeNull();
  });

  it('moves focus into the dialog when the manage modal opens', async () => {
    const manageButton = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ).find(
      (b) => (b as HTMLButtonElement).textContent?.trim() === 'Manage',
    ) as HTMLButtonElement;
    manageButton.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const dialog = fixture.nativeElement.querySelector(
      '.billing-modal',
    ) as HTMLElement;
    expect(dialog).not.toBeNull();
    const active = document.activeElement as HTMLElement;
    // Focus lands on the dialog's first control (the rate input), not body.
    expect(dialog.contains(active)).toBe(true);
    expect(active.id).toBe('manage-rate');
  });

  it('traps Tab and Shift+Tab cycling inside the manage modal', async () => {
    const manageButton = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ).find(
      (b) => (b as HTMLButtonElement).textContent?.trim() === 'Manage',
    ) as HTMLButtonElement;
    manageButton.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const dialog = fixture.nativeElement.querySelector(
      '.billing-modal',
    ) as HTMLElement;
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), ' +
          'select:not([disabled]), textarea:not([disabled]), ' +
          '[tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(focusables.length).toBeGreaterThan(1);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    // Tab on the last control wraps to the first.
    last.focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    expect(document.activeElement).toBe(first);
    // Shift+Tab on the first control wraps to the last.
    first.focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(document.activeElement).toBe(last);
    // Focus that escaped the dialog is pulled back in on Tab.
    (document.activeElement as HTMLElement).blur();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    expect(dialog.contains(document.activeElement as Node)).toBe(true);
  });

  it('closes on Esc even when focus is outside the dialog', async () => {
    const manageButton = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ).find(
      (b) => (b as HTMLButtonElement).textContent?.trim() === 'Manage',
    ) as HTMLButtonElement;
    manageButton.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.billing-modal')).not.toBeNull();
    // Focus never entered the dialog (the pre-fix bug: Esc was bound on the
    // dialog div, so it only fired when focus was already inside).
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.billing-modal')).toBeNull();
  });

  it('returns focus to the invoking button when the modal closes', async () => {
    const manageButton = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ).find(
      (b) => (b as HTMLButtonElement).textContent?.trim() === 'Manage',
    ) as HTMLButtonElement;
    manageButton.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.billing-modal')).not.toBeNull();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.billing-modal')).toBeNull();
    expect(document.activeElement).toBe(manageButton);
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

    it('shows the write UI to billing managers', () => {
      const labels = buttonLabels();
      expect(labels).toContain('Create invoice');
      expect(labels).toContain('Manage');
      expect(labels).toContain('Mark as paid');
      expect(labels.some((l) => l.startsWith('Retry'))).toBe(true);
    });

    it('hides every write action from viewers but keeps the read-only data', async () => {
      await renderAsViewer();
      const labels = buttonLabels();
      expect(labels).not.toContain('Create invoice');
      expect(labels).not.toContain('Manage');
      expect(labels).not.toContain('Mark as paid');
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

  it('opens the manage modal from a dunning Mark as paid button', async () => {
    const markPaidButton = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ).find(
      (b) => (b as HTMLButtonElement).textContent?.trim() === 'Mark as paid',
    );
    expect(markPaidButton).toBeDefined();
    (markPaidButton as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    const modal = fixture.nativeElement.querySelector(
      'app-admin-manage-invoice',
    );
    expect(modal).not.toBeNull();
    // Failed-charge context: no review-due date on the invoice summary.
    expect(modal.textContent).toContain('Failed charge');
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
