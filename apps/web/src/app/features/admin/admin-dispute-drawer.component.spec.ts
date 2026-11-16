/**
 * Admin dispute drawer (#545, admin review S12): SLA chip, evidence as a
 * definition list, humanised audit timeline, and Note + [Reject]
 * [Accept…] through ConfirmDialog (billing:manage only).
 */
import { InteractivityChecker } from '@angular/cdk/a11y';
import { DIALOG_DATA } from '@angular/cdk/dialog';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { NEVER, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingHealthResponse, DisputeDetailResponse } from '@feasly/contracts';
import { UiConfirmService, UiToastService, type UiConfirmOptions, type UiToastOptions } from '@app/shared/ui';
import { AdminDisputeDrawerComponent } from './admin-dispute-drawer.component';
import { AdminDisputesApiService } from './admin-disputes-api.service';
import { SelectAdminDispute } from './admin-disputes.actions';
import { AdminDisputesState } from './admin-disputes.state';
import { AdminAuthState } from './admin-auth.state';
import { ADMIN_PERMISSIONS } from './admin-permissions';
import { AdminBillingApiService } from './admin-billing-api.service';
import { AdminLeadsApiService } from './admin-leads-api.service';
import { BillingHealthState } from './billing-health.state';

const DETAIL: DisputeDetailResponse = {
  id: 'd1',
  invoiceId: 'inv-1',
  tenantKey: 'elite-craft',
  reason: 'Contract value reported twice',
  status: 'open',
  openedAt: '2026-09-25T12:00:00.000Z',
  slaDueAt: '2026-10-02T12:00:00.000Z',
  slaBreachedAt: null,
  commissionCents: 980000,
  currency: 'CAD',
  contractValueCents: 98000000,
  businessDaysRemaining: 0,
  breached: false,
  evidenceSnapshot: {
    invoiceId: 'inv-1',
    tenantKey: 'elite-craft',
    attributionId: 'attr-1',
    leadId: 'lead-1',
    contractValueCents: 98000000,
    commissionCents: 980000,
    currency: 'CAD',
    stripePaymentIntentId: 'pi_123',
    status: 'disputed',
    reviewDueAt: null,
    disputeReason: 'Contract value reported twice',
    invoiceCreatedAt: '2026-09-20T10:00:00.000Z',
    disputedAt: '2026-09-25T12:00:00.000Z',
    effectiveRatePercent: 1,
  },
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  auditTrail: [
    {
      id: 'e1',
      tenantKey: 'elite-craft',
      eventType: 'invoice.created',
      entityType: 'commission_invoice',
      entityId: 'inv-1',
      payload: { contractValueCents: 98000000 },
      createdAt: '2026-09-20T10:00:00.000Z',
    },
  ],
};

/** #872: a Stripe bank chargeback on a paid invoice. */
const CHARGEBACK: DisputeDetailResponse = {
  ...DETAIL,
  reason: 'fraudulent',
  source: 'chargeback',
  stripeDisputeId: 'dp_123',
  stripeReason: 'fraudulent',
  stripeStatus: 'needs_response',
  amountCents: 990000,
  evidenceDueAt: '2026-10-06T23:59:59.000Z',
  evidenceDaysRemaining: 4,
  businessDaysRemaining: 2,
  outcome: null,
  livemode: true,
  evidenceSnapshot: { ...DETAIL.evidenceSnapshot, status: 'paid' },
};

function health(provider?: 'stripe' | 'simulated'): BillingHealthResponse {
  return { stripe: { configured: true, testMode: false, ...(provider ? { provider } : {}) } } as BillingHealthResponse;
}

interface SetupOptions {
  readonly detail?: DisputeDetailResponse;
  /** Billing health provider; 'unloaded' = the health request never answers. */
  readonly provider?: 'stripe' | 'simulated' | 'unloaded';
  readonly permissions?: string[];
  readonly confirm?: boolean;
  readonly acceptFails?: boolean;
  readonly detailFails?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const api = {
    listDisputes: vi.fn(() => of({ disputes: [] })),
    getDispute: vi.fn(() =>
      options.detailFails ? throwError(() => ({ message: 'Boom' })) : of(options.detail ?? DETAIL),
    ),
    acceptDispute: vi.fn(() =>
      options.acceptFails ? throwError(() => ({ message: 'Stripe refund failed' })) : of(DETAIL),
    ),
    rejectDispute: vi.fn(() => of(DETAIL)),
  };
  const billingApi = {
    getBillingHealth: vi.fn(() =>
      options.provider === 'unloaded' ? NEVER : of(health(options.provider ?? 'stripe')),
    ),
  };
  const confirms = { confirm: vi.fn((_o: UiConfirmOptions) => of(options.confirm ?? true)) };
  const toasts = {
    show: vi.fn((_o: UiToastOptions) => ({ id: 1, dismissed: of('manual' as const), dismiss: vi.fn() })),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DIALOG_DATA, useValue: { disputeId: 'd1' } },
      provideRouter([{ path: '**', children: [] }]),
      provideLocationMocks(),
      provideStore([AdminDisputesState, AdminAuthState, BillingHealthState]),
      { provide: AdminDisputesApiService, useValue: api },
      { provide: AdminBillingApiService, useValue: billingApi },
      { provide: AdminLeadsApiService, useValue: {} },
      { provide: UiConfirmService, useValue: confirms },
      { provide: UiToastService, useValue: toasts },
      {
        provide: InteractivityChecker,
        useValue: { isFocusable: () => true, isTabbable: () => true, isVisible: () => true, isDisabled: () => false },
      },
    ],
  });
  const store = TestBed.inject(Store);
  const snapshot = store.snapshot();
  store.reset({
    ...snapshot,
    adminAuth: { ...snapshot.adminAuth, permissions: options.permissions ?? [ADMIN_PERMISSIONS.billingManage] },
  });
  store.dispatch(new SelectAdminDispute('d1')).subscribe({ error: () => undefined });
  const fixture = TestBed.createComponent(AdminDisputeDrawerComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  return { api, billingApi, confirms, toasts, store, fixture, el: fixture.nativeElement as HTMLElement };
}

/** Poll (with a deadline) for an async UI state — never a fixed sleep. */
async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    TestBed.tick();
  }
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

afterEach(() => {
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

describe('AdminDisputeDrawerComponent (#545)', () => {
  it('renders the heading, SLA chip and opened / SLA-due meta', async () => {
    const { el } = await setup();
    expect(el.querySelector('.ui-drawer__title')?.textContent?.trim()).toBe('Dispute · elite-craft');
    expect(q(el, 'drawer-sla')?.textContent?.trim()).toBe('Due today');
    expect(el.querySelector('.ui-drawer__sub')?.textContent).toContain('SLA due');
  });

  it('formats the evidence snapshot as a definition list (no raw cents)', async () => {
    const { el } = await setup();
    const evidence = q(el, 'drawer-evidence');
    expect(evidence?.querySelector('dl')).not.toBeNull();
    expect(evidence?.textContent).toContain('$980,000');
    expect(evidence?.textContent).toContain('Contract value reported twice');
    expect(el.textContent).not.toContain('98000000');
  });

  it('shows the audit trail as a humanised timeline', async () => {
    const { el } = await setup();
    const timeline = q(el, 'drawer-timeline');
    expect(timeline?.textContent).toContain('Invoice created');
    (timeline?.querySelector('.timeline__toggle') as HTMLButtonElement).click();
    await until(() => !!timeline?.querySelector('.timeline__payload'), 'details expand');
    expect(timeline?.querySelector('.timeline__payload')?.textContent).toContain('Contract value $980,000');
    expect(timeline?.textContent).not.toContain('contractValueCents');
  });

  it('links the invoice and the lead by label, never by raw id (#538)', async () => {
    const { el } = await setup();
    expect(q(el, 'drawer-invoice-link')?.textContent).toContain('View invoice');
    expect(q(el, 'drawer-lead-link')?.textContent).toContain('View lead');
    const ids = q(el, 'drawer-technical-ids') as HTMLElement;
    expect(ids.querySelector('details')?.open).toBe(false);
    expect(ids.textContent).toContain('inv-1');
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelector('[data-testid="drawer-technical-ids"]')?.remove();
    expect(clone.textContent).not.toContain('inv-1');
  });

  it('Accept goes through ConfirmDialog stating the void and refund amount (AC2), then resolves', async () => {
    const { el, api, confirms, toasts } = await setup();
    const textarea = el.querySelector('#dispute-drawer-note') as HTMLTextAreaElement;
    textarea.value = '  Duplicate report confirmed  ';
    textarea.dispatchEvent(new Event('input'));
    q(el, 'drawer-accept')?.click();

    expect(confirms.confirm).toHaveBeenCalledTimes(1);
    const options = confirms.confirm.mock.calls[0][0];
    expect(options.body).toContain('voids this $9,800 commission invoice');
    expect(options.body).toContain('$9,800 is refunded to the card first');
    await until(() => toasts.show.mock.calls.length === 1, 'resolution toast');
    expect(api.acceptDispute).toHaveBeenCalledWith('d1', 'Duplicate report confirmed');
    expect(toasts.show.mock.calls[0][0].message).toContain('voided');
  });

  it('cancelling the confirm sends nothing', async () => {
    const { el, api, confirms } = await setup({ confirm: false });
    q(el, 'drawer-accept')?.click();
    expect(confirms.confirm).toHaveBeenCalledTimes(1);
    expect(api.acceptDispute).not.toHaveBeenCalled();
  });

  it('Reject confirms, then rejects without a note', async () => {
    const { el, api, confirms } = await setup();
    q(el, 'drawer-reject')?.click();
    expect(confirms.confirm.mock.calls[0][0].body).toContain('fresh 7-day window');
    await until(() => api.rejectDispute.mock.calls.length === 1, 'reject call');
    expect(api.rejectDispute).toHaveBeenCalledWith('d1', undefined);
  });

  it('a failed resolve shows the error in the footer', async () => {
    const { el, toasts } = await setup({ acceptFails: true });
    q(el, 'drawer-accept')?.click();
    await until(() => !!el.querySelector('.dispute-drawer__error'), 'resolve error');
    expect(el.querySelector('.dispute-drawer__error')?.textContent).toContain('Stripe refund failed');
    expect(toasts.show).not.toHaveBeenCalled();
  });

  it('viewers see the evidence but no decision footer', async () => {
    const { el } = await setup({ permissions: [] });
    expect(q(el, 'drawer-evidence')).not.toBeNull();
    expect(q(el, 'drawer-footer')).toBeNull();
    expect(q(el, 'drawer-accept')).toBeNull();
    expect(q(el, 'drawer-reject')).toBeNull();
  });

  it('a failed detail load shows an error state with Retry', async () => {
    const { el, api } = await setup({ detailFails: true });
    expect(q(el, 'drawer-error')).not.toBeNull();
    (q(el, 'drawer-error')?.querySelector('button') as HTMLButtonElement).click();
    expect(api.getDispute).toHaveBeenCalledTimes(2);
  });
});

describe('AdminDisputeDrawerComponent — chargebacks (#872)', () => {
  it('marks a chargeback with a distinct chip, heading and evidence deadline', async () => {
    const { el } = await setup({ detail: CHARGEBACK });
    expect(el.querySelector('.ui-drawer__title')?.textContent?.trim()).toBe('Chargeback · elite-craft');
    expect(q(el, 'drawer-chargeback-chip')?.textContent?.trim()).toBe('Chargeback');
    expect(q(el, 'drawer-sla')?.textContent?.trim()).toBe('Evidence due in 4 days');
    expect(el.querySelector('.ui-drawer__sub')?.textContent).toContain('Evidence due');
  });

  it('summarises the disputed amount, Stripe reason and status', async () => {
    const { el } = await setup({ detail: CHARGEBACK });
    const text = el.textContent ?? '';
    expect(text).toContain('Disputed amount');
    expect(text).toContain('$9,900');
    expect(text).toContain('Fraudulent');
    expect(text).toContain('Needs response');
  });

  it('hides Accept/Reject and links to the live Stripe dashboard instead', async () => {
    const { el } = await setup({ detail: CHARGEBACK });
    expect(q(el, 'drawer-accept')).toBeNull();
    expect(q(el, 'drawer-reject')).toBeNull();
    expect(q(el, 'drawer-footer')).toBeNull();
    const link = q(el, 'drawer-view-in-stripe') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://dashboard.stripe.com/disputes/dp_123');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('uses the test-mode dashboard path when livemode is false', async () => {
    const { el } = await setup({ detail: { ...CHARGEBACK, livemode: false } });
    expect(q(el, 'drawer-view-in-stripe')?.getAttribute('href')).toBe(
      'https://dashboard.stripe.com/test/disputes/dp_123',
    );
  });

  it('hides the Stripe link for the simulated provider', async () => {
    const { el } = await setup({ detail: CHARGEBACK, provider: 'simulated' });
    expect(q(el, 'drawer-chargeback-footer')).not.toBeNull();
    expect(q(el, 'drawer-view-in-stripe')).toBeNull();
  });

  it('loads billing health once and hides the link until the provider is known', async () => {
    const { el, billingApi } = await setup({ detail: CHARGEBACK, provider: 'unloaded' });
    expect(billingApi.getBillingHealth).toHaveBeenCalledTimes(1);
    expect(q(el, 'drawer-view-in-stripe')).toBeNull();
  });

  it('read-only staff still get the Stripe link (no decision needed)', async () => {
    const { el } = await setup({ detail: CHARGEBACK, permissions: [] });
    expect(q(el, 'drawer-view-in-stripe')).not.toBeNull();
  });

  it('lists the Stripe dispute id under Technical IDs only', async () => {
    const { el } = await setup({ detail: CHARGEBACK });
    expect(q(el, 'drawer-technical-ids')?.textContent).toContain('dp_123');
  });
});
