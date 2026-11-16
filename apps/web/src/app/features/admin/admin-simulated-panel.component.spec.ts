/**
 * Admin dev panel (#791) for the simulated payment provider (#753).
 *
 * AC2: renders only when GET /api/v1/admin/billing reports
 * `stripe.provider === 'simulated'` — never for Stripe (or an unknown
 * provider) and never without `billing:manage`. Each action posts
 * `{ kind, amountCents? }` and shows the returned `eventType`; a 409 shows
 * the API's reason.
 */
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { NEVER, of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  SIMULATED_PAYMENTS_NOTICE,
  type BillingHealthResponse,
  type SimulatedInvoiceEventRequest,
  type SimulatedInvoiceEventResponse,
} from '@feasly/contracts';
import { AdminBillingApiService } from './admin-billing-api.service';
import { AdminLeadsApiService } from './admin-leads-api.service';
import { LoadBillingHealth } from './billing-health.actions';
import { BillingHealthState } from './billing-health.state';
import { AdminSimulatedPanelComponent } from './admin-simulated-panel.component';

function health(provider?: 'stripe' | 'simulated'): BillingHealthResponse {
  return {
    model: 'commission',
    stripe: { configured: true, testMode: true, ...(provider ? { provider } : {}) },
    generatedAt: '2026-11-16T12:00:00.000Z',
    mrr: { cents: null, currency: 'CAD', activeSubscriptions: 0, source: 'not_applicable' },
    collectedTrailing30d: { count: 0, commissionCents: 0 },
    inReview: {
      under48h: { count: 0, commissionCents: 0 },
      under7d: { count: 0, commissionCents: 0 },
      overdue: { count: 0, commissionCents: 0 },
    },
    disputed: { count: 0, commissionCents: 0 },
    dunning: [],
    inReviewInvoices: [],
    maxChargeRetries: 3,
    webhooks: {
      received24h: 0,
      lastReceivedAt: null,
      byType24h: [],
      unhandled24h: 0,
      modelMismatch24h: 0,
      unprocessed: [],
      awaitingSettlement: [],
      settlementThresholdHours: 24,
    },
  } as BillingHealthResponse;
}

interface Opts {
  provider?: 'stripe' | 'simulated';
  canManage?: boolean;
  fire?: (id: string, body: SimulatedInvoiceEventRequest) => Observable<SimulatedInvoiceEventResponse>;
  /** Leave the health payload unloaded (opened from /admin/invoices). */
  unloaded?: boolean;
}

async function setup(opts: Opts = {}) {
  const api = {
    getBillingHealth: vi.fn(() => (opts.unloaded ? NEVER : of(health(opts.provider)))),
    fireSimulatedInvoiceEvent: vi.fn(
      opts.fire ??
        ((id: string, body: SimulatedInvoiceEventRequest) =>
          of<SimulatedInvoiceEventResponse>({
            invoiceId: id,
            paymentIntentId: 'pi_sim_1',
            kind: body.kind,
            eventType: body.kind === 'dispute' ? 'charge.dispute.created' : 'charge.refunded',
          })),
    ),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AdminSimulatedPanelComponent],
    providers: [
      provideStore([BillingHealthState]),
      { provide: AdminBillingApiService, useValue: api },
      { provide: AdminLeadsApiService, useValue: {} },
    ],
  });
  const store = TestBed.inject(Store);
  const dispatch = vi.spyOn(store, 'dispatch');
  const fixture: ComponentFixture<AdminSimulatedPanelComponent> = TestBed.createComponent(AdminSimulatedPanelComponent);
  fixture.componentRef.setInput('invoiceId', '7b0c8a3e-1f2d-4c5b-9a8e-0d1c2b3a4f5e');
  fixture.componentRef.setInput('canManage', opts.canManage ?? true);
  const fired: string[] = [];
  fixture.componentInstance.fired.subscribe((e) => fired.push(e));
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, api, dispatch, fired };
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function settle(fixture: ComponentFixture<AdminSimulatedPanelComponent>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('AdminSimulatedPanelComponent (#791)', () => {
  it('loads billing health when nothing loaded it yet', async () => {
    const { dispatch, el } = await setup({ unloaded: true });
    expect(dispatch).toHaveBeenCalledWith(expect.any(LoadBillingHealth));
    expect(q(el, 'simulated-dev-panel')).toBeNull();
  });

  it('renders the three actions and the test-mode notice for the simulated provider', async () => {
    const { el } = await setup({ provider: 'simulated' });
    const panel = q(el, 'simulated-dev-panel');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain(SIMULATED_PAYMENTS_NOTICE);
    expect(q(el, 'sim-fire-dispute')?.textContent).toContain('Fire dispute');
    expect(q(el, 'sim-refund')?.textContent).toContain('Dashboard refund');
    expect(q(el, 'sim-delayed-failure')?.textContent).toContain('Delayed failure');
  });

  it.each([['stripe' as const], [undefined]])('never renders for provider %s (AC2)', async (provider) => {
    const { el } = await setup({ provider });
    expect(q(el, 'simulated-dev-panel')).toBeNull();
  });

  it('never renders without billing:manage', async () => {
    const { el } = await setup({ provider: 'simulated', canManage: false });
    expect(q(el, 'simulated-dev-panel')).toBeNull();
  });

  it('Fire dispute posts { kind: "dispute" }, shows the eventType and emits fired', async () => {
    const { el, fixture, api, fired } = await setup({ provider: 'simulated' });
    q(el, 'sim-fire-dispute')!.click();
    await settle(fixture);
    expect(api.fireSimulatedInvoiceEvent).toHaveBeenCalledWith('7b0c8a3e-1f2d-4c5b-9a8e-0d1c2b3a4f5e', {
      kind: 'dispute',
    });
    expect(q(el, 'sim-result')?.textContent).toContain('charge.dispute.created');
    expect(fired).toEqual(['charge.dispute.created']);
  });

  it('Delayed failure posts { kind: "delayed_failure" }', async () => {
    const { el, fixture, api } = await setup({ provider: 'simulated' });
    q(el, 'sim-delayed-failure')!.click();
    await settle(fixture);
    expect(api.fireSimulatedInvoiceEvent).toHaveBeenCalledWith(expect.any(String), { kind: 'delayed_failure' });
  });

  it('Dashboard refund is full when the amount is blank, partial with whole cents', async () => {
    const { el, fixture, api } = await setup({ provider: 'simulated' });
    q(el, 'sim-refund')!.click();
    await settle(fixture);
    expect(api.fireSimulatedInvoiceEvent).toHaveBeenLastCalledWith(expect.any(String), { kind: 'refund' });

    const input = el.querySelector('input') as HTMLInputElement;
    input.value = '2500';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
    q(el, 'sim-refund')!.click();
    await settle(fixture);
    expect(api.fireSimulatedInvoiceEvent).toHaveBeenLastCalledWith(expect.any(String), {
      kind: 'refund',
      amountCents: 2500,
    });
  });

  it('blocks a refund amount that is not whole cents', async () => {
    const { el, fixture, api } = await setup({ provider: 'simulated' });
    const input = el.querySelector('input') as HTMLInputElement;
    input.value = '12.50';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect((q(el, 'sim-refund') as HTMLButtonElement).disabled).toBe(true);
    expect(api.fireSimulatedInvoiceEvent).not.toHaveBeenCalled();
  });

  it('shows the API reason on a 409 (action does not apply) and emits nothing', async () => {
    const reason = 'Invoice has not been charged yet — there is no payment to act on';
    const { el, fixture, fired } = await setup({
      provider: 'simulated',
      fire: () => throwError(() => ({ code: 'CONFLICT', message: reason, retryable: false })),
    });
    q(el, 'sim-delayed-failure')!.click();
    await settle(fixture);
    expect(q(el, 'sim-result')?.textContent).toContain(reason);
    expect(fired).toEqual([]);
    expect((q(el, 'sim-delayed-failure') as HTMLButtonElement).disabled).toBe(false);
  });
});
