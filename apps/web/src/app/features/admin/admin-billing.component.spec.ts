import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { BillingHealthResponse } from '@feasly/contracts';
import { AdminBillingApiService } from './admin-billing-api.service';
import { BillingHealthState } from './billing-health.state';
import { AdminBillingComponent } from './admin-billing.component';

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
      pastDueSince: '2026-09-24T12:00:00.000Z',
    },
  ],
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

  beforeEach(async () => {
    const api = {
      getBillingHealth: vi.fn().mockReturnValue(of(HEALTH)),
    };
    await TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        provideRouter([]),
        provideStore([BillingHealthState]),
        { provide: AdminBillingApiService, useValue: api },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminBillingComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('loads billing health on init and renders the panels', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Billing health');
    expect(text).toContain('Commission · 1%');
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
    };
    const { billingHealthStateProvider } = await import('./billing-health.state');
    await TestBed.configureTestingModule({
      imports: [AdminBillingComponent],
      providers: [
        provideRouter([]),
        // Production root store: BillingHealthState is NOT here (it is
        // lazy-loaded at the admin/billing route).
        provideStore([]),
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
