/**
 * Admin invoice drawer (#543, review S10/S11): header, status-dependent
 * actions (AC1 — three intent-specific modals), the disputed invoice's
 * link to its dispute (AC2), and the activity timeline.
 */
import { DIALOG_DATA } from '@angular/cdk/dialog';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { DisputeDetailResponse } from '@feasly/contracts';
import { UiDrawerRef, UiModalService } from '@app/shared/ui';
import { BuilderInvoicesApiService, type BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import { AdminAuthState } from './admin-auth.state';
import { AdminDisputesApiService } from './admin-disputes-api.service';
import { AdminInvoiceDrawerComponent } from './admin-invoice-drawer.component';
import { AdminInvoiceMethodModalComponent } from './admin-invoice-method-modal.component';
import { AdminInvoicePaymentModalComponent } from './admin-invoice-payment-modal.component';
import { AdminInvoiceRateModalComponent } from './admin-invoice-rate-modal.component';
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
  const modalResult = options.modalResult ?? new Subject<boolean | undefined>();
  const modals = { open: vi.fn(() => ({ closed: modalResult.asObservable() })) };
  const ref = { titleId: 'drawer-title', urlId: 'inv-1', setDirty: vi.fn(), close: vi.fn(), requestClose: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideStore([AdminInvoicesState, AdminAuthState]),
      { provide: BuilderInvoicesApiService, useValue: invoicesApi },
      { provide: AdminDisputesApiService, useValue: disputesApi },
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
  return { fixture, store, el, q, invoicesApi, disputesApi, modals, modalResult };
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
});
