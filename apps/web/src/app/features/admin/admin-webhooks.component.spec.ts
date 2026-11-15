/**
 * Admin Webhooks page (#547): Stripe webhook health split out of Billing.
 *
 * Verifies the header health chip, KPI tiles with kit counts, the
 * unhandled / model-mismatch alerts, the event-type DataTable (busiest
 * first), kit-formatted dates, and that every control is a kit control.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { NEVER, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingHealthResponse, BillingHealthWebhooks } from '@feasly/contracts';
import { AdminBillingApiService } from './admin-billing-api.service';
import { AdminWebhooksComponent } from './admin-webhooks.component';
import { LoadBillingHealth } from './billing-health.actions';
import { BillingHealthState } from './billing-health.state';

function makeHealth(webhooks: Partial<BillingHealthWebhooks> = {}): BillingHealthResponse {
  return {
    model: 'commission',
    stripe: { configured: true, testMode: true },
    generatedAt: '2026-07-12T17:30:45.000Z',
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
      received24h: 1843,
      lastReceivedAt: '2026-07-12T16:00:00.000Z',
      byType24h: [
        { type: 'invoice.paid', count: 3 },
        { type: 'payment_intent.succeeded', count: 1840 },
      ],
      unhandled24h: 0,
      modelMismatch24h: 0,
      unprocessed: [],
      awaitingSettlement: [],
      settlementThresholdHours: 24,
      ...webhooks,
    },
  } as BillingHealthResponse;
}

async function setup(
  response: 'never' | 'error' | BillingHealthResponse = makeHealth(),
) {
  TestBed.resetTestingModule();
  const api = {
    getBillingHealth: vi
      .fn()
      .mockReturnValue(
        response === 'never'
          ? NEVER
          : response === 'error'
            ? throwError(() => new Error('boom'))
            : of(response),
      ),
  };
  TestBed.configureTestingModule({
    imports: [AdminWebhooksComponent],
    providers: [provideStore([BillingHealthState]), { provide: AdminBillingApiService, useValue: api }],
  });
  const fixture: ComponentFixture<AdminWebhooksComponent> = TestBed.createComponent(AdminWebhooksComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, api, store: TestBed.inject(Store), el: fixture.nativeElement as HTMLElement };
}

describe('AdminWebhooksComponent (#547)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('loads billing health and renders the kit page header + KPIs', async () => {
    const { el, api } = await setup();
    expect(api.getBillingHealth).toHaveBeenCalledTimes(1);
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Webhooks');
    expect(el.querySelectorAll('ui-kpi-tile').length).toBe(3);
    expect(el.textContent).toContain('1,843');
    expect(el.querySelector('ui-page-header ui-status-chip')?.textContent?.trim()).toBe('All clear');
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('lists event types busiest first in a DataTable', async () => {
    const { el } = await setup();
    const types = Array.from(el.querySelectorAll('.ui-dt__table .webhooks-page__type')).map((n) =>
      n.textContent?.trim(),
    );
    expect(types).toEqual(['payment_intent.succeeded', 'invoice.paid']);
  });

  it('flags unhandled events with a warning alert and tile tone', async () => {
    const { el } = await setup(makeHealth({ unhandled24h: 2 }));
    expect(el.querySelector('ui-page-header ui-status-chip')?.textContent?.trim()).toBe('Needs attention');
    const alert = el.querySelector('.webhooks-page__alert--warning');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('2 unhandled events');
    expect(el.querySelector('.kpi--warning')).not.toBeNull();
  });

  it('flags model mismatches as a problem', async () => {
    const { el } = await setup(makeHealth({ modelMismatch24h: 1 }));
    expect(el.querySelector('ui-page-header ui-status-chip')?.textContent?.trim()).toBe('Problem');
    expect(el.querySelector('.webhooks-page__alert--danger')?.textContent).toContain('1 model mismatch');
    expect(el.querySelector('.kpi--danger')).not.toBeNull();
  });

  it('shows empty states for unprocessed events and awaiting settlement (#711)', async () => {
    const { el } = await setup();
    expect(el.querySelector('[data-testid="unprocessed-section"]')?.textContent).toContain(
      'Every received event was processed',
    );
    expect(el.querySelector('[data-testid="awaiting-section"]')?.textContent).toContain(
      'No invoices waiting on a charge result',
    );
    expect(el.querySelector('[data-testid="unprocessed-alert"]')).toBeNull();
    expect(el.querySelector('[data-testid="awaiting-alert"]')).toBeNull();
  });

  it('flags events received but not processed as a problem and lists them (#711)', async () => {
    const { el } = await setup(
      makeHealth({
        unprocessed: [
          { eventId: 'evt_stuck_1', type: 'payment_intent.succeeded', receivedAt: '2026-07-12T12:00:00.000Z' },
        ],
      }),
    );
    expect(el.querySelector('ui-page-header ui-status-chip')?.textContent?.trim()).toBe('Problem');
    expect(el.querySelector('[data-testid="unprocessed-alert"]')?.textContent).toContain(
      '1 event received but not processed',
    );
    expect(el.querySelector('[data-testid="unprocessed-section"]')?.textContent).toContain('evt_stuck_1');
  });

  it('flags invoices awaiting settlement past the threshold (#711)', async () => {
    const { el } = await setup(
      makeHealth({
        settlementThresholdHours: 24,
        awaitingSettlement: [
          {
            id: 'inv-1',
            tenantKey: 'elite-craft-builders',
            commissionCents: 500_000,
            currency: 'CAD',
            awaitingSince: '2026-07-10T12:00:00.000Z',
          },
        ],
      }),
    );
    expect(el.querySelector('ui-page-header ui-status-chip')?.textContent?.trim()).toBe('Needs attention');
    const alert = el.querySelector('[data-testid="awaiting-alert"]');
    expect(alert?.textContent).toContain('1 invoice awaiting settlement');
    expect(alert?.textContent).toContain('24 hours');
    const section = el.querySelector('[data-testid="awaiting-section"]')?.textContent ?? '';
    expect(section).toContain('elite-craft-builders');
    expect(section).toContain('$5,000');
  });

  it('formats dates through the kit pipes (no raw ISO, no seconds)', async () => {
    const { el } = await setup();
    const text = el.textContent ?? '';
    expect(text).toContain('Generated Jul 12, 2026 · 11:30 a.m. MT');
    expect(text).toContain('Last event Jul 12, 2026 · 10:00 a.m. MT');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toMatch(/\d:\d{2}:\d{2}/);
  });

  it('says so when no events arrived', async () => {
    const { el } = await setup(makeHealth({ received24h: 0, lastReceivedAt: null, byType24h: [] }));
    expect(el.textContent).toContain('None in the last 24h');
    expect(el.textContent).toContain('No webhook events in the last 24 hours');
  });

  it('refreshes from the kit Refresh button', async () => {
    const { el, store } = await setup();
    const dispatch = vi.spyOn(store, 'dispatch');
    const button = el.querySelector('[data-testid="refresh-webhooks"]') as HTMLButtonElement;
    expect(button.classList).toContain('ui-button');
    button.click();
    expect(dispatch).toHaveBeenCalledWith(expect.any(LoadBillingHealth));
  });

  it('shows the kit error state when the first load fails', async () => {
    const { el } = await setup('error');
    expect(el.querySelector('ui-error-state')?.textContent).toContain("Couldn't load webhook health");
  });

  it('shows a skeleton while loading', async () => {
    const { el } = await setup('never');
    expect(el.querySelector('ui-skeleton')).not.toBeNull();
  });
});
