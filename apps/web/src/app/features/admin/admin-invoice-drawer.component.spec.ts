/**
 * Admin invoice drawer (#543, review S10/S11): header, status-dependent
 * actions (AC1 — three intent-specific modals), the disputed invoice's
 * link to its dispute (AC2), and the activity timeline.
 */
import { DIALOG_DATA } from '@angular/cdk/dialog';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { AuditLogEntry, BillingHealthResponse, DisputeDetailResponse, InvoiceRefund } from '@feasly/contracts';
import { UiDrawerRef, UiModalService } from '@app/shared/ui';
import { BuilderInvoicesApiService, type BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import { AdminAuditApiService } from './admin-audit-api.service';
import { AdminAuthState } from './admin-auth.state';
import { AdminBillingApiService } from './admin-billing-api.service';
import { AdminLeadsApiService } from './admin-leads-api.service';
import { BillingHealthState } from './billing-health.state';
import { LoadAdminInvoiceDetail } from './admin-invoices.actions';
import { AdminDisputesApiService } from './admin-disputes-api.service';
import { AdminInvoiceDrawerComponent } from './admin-invoice-drawer.component';
import { AdminInvoiceMethodModalComponent } from './admin-invoice-method-modal.component';
import { AdminInvoicePaymentModalComponent } from './admin-invoice-payment-modal.component';
import { AdminInvoiceRateModalComponent } from './admin-invoice-rate-modal.component';
import { AdminInvoiceRefundModalComponent } from './admin-invoice-refund-modal.component';
import { AdminInvoiceVoidModalComponent } from './admin-invoice-void-modal.component';
import { AdminInvoiceContractModalComponent } from './admin-invoice-contract-modal.component';
import { AdminInvoiceReverseModalComponent } from './admin-invoice-reverse-modal.component';
import { AdminInvoicesState } from './admin-invoices.state';
import { ADMIN_PERMISSIONS } from './admin-permissions';

const INVOICE: BuilderCommissionInvoice = {
  id: 'inv-1',
  tenantKey: 'elite-craft',
  attributionId: 'attr-1',
  leadId: 'lead-1',
  leadName: 'Ava Smith',
  contractValueCents: 198_000_000,
  commissionCents: 1_980_000,
  subtotalCents: 1_980_000,
  taxRatePercent: 0,
  taxInclusive: false,
  taxCents: 0,
  totalCents: 1_980_000,
  taxLabel: null,
  currency: 'CAD',
  stripePaymentIntentId: null,
  status: 'in_review',
  reviewDueAt: '2026-11-20T12:00:00.000Z',
  finalizedAt: null,
  paidAt: null,
  slaBreached: false,
  disputeReason: null,
  commissionRateOverride: null,
  commissionRatePercent: 1,
  effectiveRatePercent: 1,
  manualPaymentMethod: null,
  paymentReference: null,
  invoiceNumber: 'INV-0042',
  paymentMethod: 'card',
  createdAt: '2026-11-13T12:00:00.000Z',
  updatedAt: '2026-11-13T12:00:00.000Z',
};

const DISPUTE: DisputeDetailResponse = {
  id: 'disp-9',
  invoiceId: 'inv-1',
  tenantKey: 'elite-craft',
  reason: 'Contract value is wrong',
  status: 'open',
  openedAt: '2026-11-14T12:00:00.000Z',
  slaDueAt: '2026-11-21T12:00:00.000Z',
  slaBreachedAt: null,
  commissionCents: 1_980_000,
  currency: 'CAD',
  contractValueCents: 198_000_000,
  businessDaysRemaining: 4,
  breached: false,
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  evidenceSnapshot: {} as DisputeDetailResponse['evidenceSnapshot'],
  auditTrail: [
    {
      id: 'ev-1',
      tenantKey: 'elite-craft',
      eventType: 'invoice_created',
      entityType: 'invoice',
      entityId: 'inv-1',
      payload: null,
      createdAt: '2026-11-13T12:00:00.000Z',
    },
    {
      id: 'ev-2',
      tenantKey: 'elite-craft',
      eventType: 'dispute_opened',
      entityType: 'dispute',
      entityId: 'disp-9',
      payload: null,
      createdAt: '2026-11-14T12:00:00.000Z',
    },
  ],
};

interface Options {
  readonly invoice?: BuilderCommissionInvoice;
  readonly permissions?: string[];
  readonly modalResult?: Subject<boolean | undefined>;
  /** #791: payment provider reported by GET /admin/billing. */
  readonly provider?: 'stripe' | 'simulated';
  /** #862: entries GET /admin/audit returns for the invoice. */
  readonly audit?: readonly AuditLogEntry[] | 'error';
}

async function setup(options: Options = {}) {
  const invoice = options.invoice ?? INVOICE;
  const invoicesApi = {
    getInvoice: vi.fn(() => of(invoice)),
    listInvoices: vi.fn(() => of({ invoices: [invoice], total: null, page: 1, pageSize: 20 })),
  };
  const disputesApi = {
    listDisputes: vi.fn(() => of({ disputes: [DISPUTE] })),
    getDispute: vi.fn(() => of(DISPUTE)),
  };
  const billingApi = {
    getBillingHealth: vi.fn(() =>
      of({
        stripe: { configured: true, testMode: true, provider: options.provider ?? 'stripe' },
      } as BillingHealthResponse),
    ),
    fireSimulatedInvoiceEvent: vi.fn(() =>
      of({ invoiceId: invoice.id, paymentIntentId: 'pi_sim_1', kind: 'dispute' as const, eventType: 'charge.dispute.created' }),
    ),
  };
  const audit = options.audit;
  const auditApi = {
    list: vi.fn(() =>
      audit === 'error' ? throwError(() => ({ status: 403 })) : of({ items: audit ?? [], nextCursor: null }),
    ),
  };
  const modalResult = options.modalResult ?? new Subject<boolean | undefined>();
  const modals = { open: vi.fn(() => ({ closed: modalResult.asObservable() })) };
  const ref = { titleId: 'drawer-title', urlId: 'inv-1', setDirty: vi.fn(), close: vi.fn(), requestClose: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideStore([AdminInvoicesState, AdminAuthState, BillingHealthState]),
      { provide: AdminBillingApiService, useValue: billingApi },
      { provide: AdminLeadsApiService, useValue: {} },
      { provide: BuilderInvoicesApiService, useValue: invoicesApi },
      { provide: AdminDisputesApiService, useValue: disputesApi },
      { provide: AdminAuditApiService, useValue: auditApi },
      { provide: UiModalService, useValue: modals },
      { provide: UiDrawerRef, useValue: ref },
      { provide: DIALOG_DATA, useValue: { invoiceId: invoice.id } },
    ],
  });
  const store = TestBed.inject(Store);
  store.reset({
    ...store.snapshot(),
    adminAuth: {
      ...store.selectSnapshot((s) => s.adminAuth),
      permissions: options.permissions ?? [ADMIN_PERMISSIONS.billingManage],
    },
  });
  const fixture = TestBed.createComponent(AdminInvoiceDrawerComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return { fixture, store, el, q, invoicesApi, disputesApi, modals, modalResult, billingApi, auditApi };
}

describe('AdminInvoiceDrawerComponent', () => {
  it('shows the invoice number, status, builder, lead link, amounts and technical IDs', async () => {
    const { el, q } = await setup();
    expect(el.textContent).toContain('INV-0042');
    expect(el.textContent).toContain('In review');
    expect(el.textContent).toContain('elite-craft');
    expect(q('invoice-lead-link')?.getAttribute('href')).toBe('/admin/leads?open=lead-1');
    expect(el.textContent).toContain('$19,800');
    expect(el.textContent).toContain('Technical IDs');
    expect(el.textContent).toContain('attr-1');
  });

  it('#764: shows total, commission subtotal and the GST line to the cent for a taxed invoice', async () => {
    const { q } = await setup({
      invoice: { ...INVOICE, taxCents: 99_000, totalCents: 2_079_000, taxRatePercent: 5, taxLabel: 'GST' },
    });
    expect(q('invoice-total')?.textContent).toContain('$20,790');
    expect(q('invoice-subtotal')?.textContent).toContain('$19,800');
    expect(q('invoice-tax')?.textContent).toContain('GST (5%)');
    expect(q('invoice-tax')?.textContent).toContain('$990');
  });

  it('#872: shows the refunded amount and the chargeback state on a charged-back invoice', async () => {
    const { q } = await setup({
      invoice: { ...INVOICE, status: 'paid', refundedCents: 250_000, chargebackStatus: 'open' },
    });
    expect(q('invoice-refunded')?.textContent).toContain('$2,500');
    expect(q('invoice-chargeback')?.textContent).toContain('Chargeback open');
  });

  it('#872: no refund / chargeback rows when refundedCents is 0 and there is no chargeback', async () => {
    const { q } = await setup({ invoice: { ...INVOICE, refundedCents: 0, chargebackStatus: null } });
    expect(q('invoice-refunded')).toBeNull();
    expect(q('invoice-chargeback')).toBeNull();
  });

  it('#764 AC2: an untaxed invoice shows no tax rows', async () => {
    const { q, el } = await setup();
    expect(q('invoice-tax')).toBeNull();
    expect(q('invoice-total')).toBeNull();
    expect(el.textContent).toContain('$19,800');
  });

  it('offers Change rate, Change payment method and Record payment on an unpaid invoice (AC1)', async () => {
    const { q, modals } = await setup();
    q('action-rate')!.click();
    expect(modals.open).toHaveBeenLastCalledWith(
      AdminInvoiceRateModalComponent,
      expect.objectContaining({ data: { invoice: expect.objectContaining({ id: 'inv-1' }) }, size: 'sm' }),
    );
    q('action-method')!.click();
    expect(modals.open).toHaveBeenLastCalledWith(AdminInvoiceMethodModalComponent, expect.anything());
    q('action-payment')!.click();
    expect(modals.open).toHaveBeenLastCalledWith(AdminInvoicePaymentModalComponent, expect.anything());
  });

  it('refreshes the invoice after a modal saves', async () => {
    const { q, invoicesApi, modalResult } = await setup();
    q('action-rate')!.click();
    expect(invoicesApi.getInvoice).toHaveBeenCalledTimes(1);
    modalResult.next(true);
    expect(invoicesApi.getInvoice).toHaveBeenCalledTimes(2);
  });

  it('does not refresh when a modal is dismissed', async () => {
    const { q, invoicesApi, modalResult } = await setup();
    q('action-rate')!.click();
    modalResult.next(undefined);
    expect(invoicesApi.getInvoice).toHaveBeenCalledTimes(1);
  });

  it('hides the actions from read-only staff', async () => {
    const { q } = await setup({ permissions: [] });
    expect(q('action-rate')).toBeNull();
    expect(q('action-payment')).toBeNull();
  });

  it('hides the actions on a paid invoice', async () => {
    const { q, el } = await setup({
      invoice: { ...INVOICE, status: 'paid', paidAt: '2026-11-14T12:00:00.000Z', manualPaymentMethod: 'cheque' },
    });
    expect(q('action-rate')).toBeNull();
    expect(el.textContent).toContain('Payment recorded (Cheque)');
  });

  it('links a disputed invoice to its dispute and shows the dispute audit trail (AC2)', async () => {
    const { q, el, disputesApi } = await setup({
      invoice: { ...INVOICE, status: 'disputed', disputeReason: 'Contract value is wrong' },
    });
    expect(disputesApi.getDispute).toHaveBeenCalledWith('disp-9');
    expect(q('invoice-dispute')?.textContent).toContain('Contract value is wrong');
    expect(q('open-dispute')?.getAttribute('href')).toBe('/admin/disputes?open=disp-9');
    expect(el.textContent).toContain('Dispute opened');
    expect(q('action-rate')).toBeNull();
  });

  it('falls back to the disputes queue when no open dispute matches', async () => {
    const { q, disputesApi } = await setup({
      invoice: { ...INVOICE, id: 'inv-2', status: 'disputed' },
    });
    expect(disputesApi.getDispute).not.toHaveBeenCalled();
    expect(q('open-dispute')).toBeNull();
    expect(q('open-disputes')?.getAttribute('href')).toBe('/admin/disputes');
  });

  describe('simulated dev panel (#791)', () => {
    it('is absent for the Stripe provider (AC2)', async () => {
      const { q } = await setup({ provider: 'stripe' });
      expect(q('simulated-dev-panel')).toBeNull();
    });

    it('shows for the simulated provider and reloads the invoice after an event', async () => {
      const { q, fixture, store, billingApi } = await setup({ provider: 'simulated' });
      expect(q('simulated-dev-panel')).not.toBeNull();
      const dispatch = vi.spyOn(store, 'dispatch');
      q('sim-fire-dispute')!.click();
      await fixture.whenStable();
      expect(billingApi.fireSimulatedInvoiceEvent).toHaveBeenCalledWith('inv-1', { kind: 'dispute' });
      expect(dispatch).toHaveBeenCalledWith(expect.any(LoadAdminInvoiceDetail));
    });
  });
  describe('#862 adjustments (API #715)', () => {
    const PAID: BuilderCommissionInvoice = {
      ...INVOICE,
      status: 'paid',
      paidAt: '2026-11-14T12:00:00.000Z',
      stripePaymentIntentId: 'pi_1',
      refundedCents: 0,
      refundState: 'none',
    };
    const visible = (q: (id: string) => HTMLElement | null) =>
      ['action-correct', 'action-refund', 'action-reverse', 'action-void'].filter((id) => q(id) !== null);

    it.each([
      ['draft', ['action-correct', 'action-void']],
      ['in_review', ['action-correct', 'action-void']],
      ['failed', ['action-void']],
      ['finalized', []],
      ['disputed', []],
      ['void', []],
    ] as const)('a %s invoice offers %j', async (status, expected) => {
      const { q } = await setup({ invoice: { ...INVOICE, id: 'inv-2', status } });
      expect(visible(q)).toEqual(expected);
    });

    it('a card-paid invoice offers Refund only; paid by hand adds Reverse payment', async () => {
      expect(visible((await setup({ invoice: PAID })).q)).toEqual(['action-refund']);
      const manual = await setup({ invoice: { ...PAID, manualPaymentMethod: 'cheque', stripePaymentIntentId: null } });
      expect(visible(manual.q)).toEqual(['action-refund', 'action-reverse']);
    });

    it('hides Refund once fully refunded and Reverse once anything was refunded', async () => {
      const { q } = await setup({
        invoice: { ...PAID, manualPaymentMethod: 'cheque', refundedCents: 1_980_000, refundState: 'refunded' },
      });
      expect(visible(q)).toEqual([]);
    });

    it('hides every adjustment from read-only staff', async () => {
      const { q } = await setup({ invoice: PAID, permissions: [] });
      expect(visible(q)).toEqual([]);
    });

    it('opens each action in its own modal and refreshes after a save', async () => {
      const { q, modals, modalResult, invoicesApi } = await setup({ invoice: PAID });
      q('action-refund')!.click();
      expect(modals.open).toHaveBeenLastCalledWith(
        AdminInvoiceRefundModalComponent,
        expect.objectContaining({ data: { invoice: expect.objectContaining({ id: 'inv-1' }) }, size: 'sm' }),
      );
      modalResult.next(true);
      expect(invoicesApi.getInvoice).toHaveBeenCalledTimes(2);

      const draft = await setup({ invoice: { ...INVOICE, status: 'draft' } });
      draft.q('action-void')!.click();
      expect(draft.modals.open).toHaveBeenLastCalledWith(AdminInvoiceVoidModalComponent, expect.anything());
      draft.q('action-correct')!.click();
      expect(draft.modals.open).toHaveBeenLastCalledWith(AdminInvoiceContractModalComponent, expect.anything());

      const manual = await setup({ invoice: { ...PAID, manualPaymentMethod: 'cheque' } });
      manual.q('action-reverse')!.click();
      expect(manual.modals.open).toHaveBeenLastCalledWith(AdminInvoiceReverseModalComponent, expect.anything());
    });

    it('lists the refund rows with the refunded total, the badge and the net paid', async () => {
      const refund = (over: Partial<InvoiceRefund>): InvoiceRefund => ({
        id: 'rf-1',
        invoiceId: 'inv-1',
        amountCents: 50_050,
        currency: 'CAD',
        reason: 'billing_error',
        note: 'Rate was wrong',
        method: 'stripe',
        status: 'succeeded',
        stripeRefundId: 're_1',
        reference: null,
        actorEmail: 'ops@feasly.ca',
        createdAt: '2026-11-15T12:00:00.000Z',
        ...over,
      });
      const { q, el } = await setup({
        invoice: {
          ...PAID,
          refundedCents: 60_050,
          refundState: 'partially_refunded',
          refunds: [refund({}), refund({ id: 'rf-2', amountCents: 10_000, status: 'pending', note: null })],
        },
      });
      expect(q('invoice-refunded')?.textContent).toContain('$600.50');
      expect(q('invoice-refunded')?.textContent).toContain('Partially refunded');
      expect(q('invoice-net-paid')?.textContent).toContain('$19,199.50');
      const rows = el.querySelectorAll('[data-testid="invoice-refund-row"]');
      expect(rows).toHaveLength(2);
      expect(rows[0].textContent).toContain('$500.50');
      expect(rows[0].textContent).toContain('Billing error');
      expect(rows[0].textContent).toContain('Card refund (Stripe)');
      expect(rows[0].textContent).toContain('ops@feasly.ca');
      expect(rows[0].textContent).toContain('Rate was wrong');
      expect(rows[1].textContent).toContain('Pending');
    });

    it('shows no refund rows or net paid when nothing was refunded', async () => {
      const { q } = await setup({ invoice: PAID });
      expect(q('invoice-refunds')).toBeNull();
      expect(q('invoice-net-paid')).toBeNull();
    });

    it('adds refunded / voided / contract-corrected / payment-reversed events to the timeline', async () => {
      const at = (action: string, minute: number): AuditLogEntry => ({
        id: `billing:${action}`,
        source: 'billing',
        occurredAt: `2026-11-16T12:${String(minute).padStart(2, '0')}:00.000Z`,
        actorEmail: 'ops@feasly.ca',
        action,
        entityType: 'invoice',
        entityId: 'inv-1',
        tenantKey: 'elite-craft',
        impersonation: false,
        payload: { reason: 'other' },
      });
      const { el, auditApi } = await setup({
        audit: [
          at('invoice.refunded', 1),
          at('invoice.voided', 2),
          at('invoice.contract_corrected', 3),
          at('invoice.payment_reversed', 4),
        ],
      });
      expect(auditApi.list).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'invoice', entityId: 'inv-1', source: 'billing' }),
      );
      const text = el.textContent ?? '';
      for (const title of ['Refunded', 'Voided', 'Contract corrected', 'Payment reversed', 'Invoice created']) {
        expect(text).toContain(title);
      }
    });

    it('keeps the base timeline when the audit log cannot be read', async () => {
      const { el, auditApi } = await setup({ audit: 'error' });
      expect(auditApi.list).toHaveBeenCalled();
      expect(el.textContent).toContain('Invoice created');
      expect(el.textContent).not.toContain('Could not load');
    });
  });
});
