/**
 * Invoice action modals (#543, review S10, AC1): each intent gets its own
 * modal with a before → after, dispatches the existing BillingHealth
 * action, closes with `true` + toast on success, and keeps a server error
 * inline.
 */
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideStore } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { UiToastService } from '@app/shared/ui';
import type { BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import { AdminBillingApiService } from './admin-billing-api.service';
import { AdminInvoiceMethodModalComponent } from './admin-invoice-method-modal.component';
import { AdminInvoicePaymentModalComponent } from './admin-invoice-payment-modal.component';
import { AdminInvoiceRateModalComponent } from './admin-invoice-rate-modal.component';
import { BillingHealthState } from './billing-health.state';

const INVOICE = {
  id: 'inv-1',
  tenantKey: 'elite-craft',
  invoiceNumber: 'INV-0042',
  contractValueCents: 198_000_000,
  commissionCents: 1_980_000,
  effectiveRatePercent: 1,
  status: 'in_review',
  paymentMethod: 'card',
} as BuilderCommissionInvoice;

async function setup<C>(component: Type<C>, fail = false) {
  const api = {
    getBillingHealth: vi.fn(() => of(null)),
    setCommissionRate: vi.fn((_id: string, rate: number) =>
      fail
        ? throwError(() => ({ status: 409, message: 'Invoice is no longer editable.' }))
        : of({ id: 'inv-1', commissionCents: Math.round(198_000_000 * rate / 100), commissionRatePercent: rate }),
    ),
    setInvoicePaymentMethod: vi.fn((_id: string, method: string) => of({ id: 'inv-1', paymentMethod: method })),
    markInvoicePaid: vi.fn(() => of({ id: 'inv-1', paidAt: '2026-11-15T12:00:00.000Z', paymentMethod: 'cheque' })),
  };
  const ref = { close: vi.fn() };
  const toasts = { show: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideStore([BillingHealthState]),
      { provide: AdminBillingApiService, useValue: api },
      { provide: DialogRef, useValue: ref },
      { provide: UiToastService, useValue: toasts },
      { provide: DIALOG_DATA, useValue: { invoice: INVOICE } },
    ],
  });
  const fixture = TestBed.createComponent(component);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const type = async (selector: string, value: string, event = 'input') => {
    const input = el.querySelector(selector) as HTMLInputElement | HTMLSelectElement;
    input.value = value;
    input.dispatchEvent(new Event(event));
    await fixture.whenStable();
  };
  const submit = async () => {
    (q(`${prefix(component)}-submit`) as HTMLButtonElement).click();
    await fixture.whenStable();
  };
  return { fixture, el, q, type, submit, api, ref, toasts };
}

function prefix(component: unknown): string {
  if (component === AdminInvoiceRateModalComponent) return 'rate';
  if (component === AdminInvoiceMethodModalComponent) return 'method';
  return 'payment';
}

describe('AdminInvoiceRateModalComponent', () => {
  it('shows the rate and amount before → after and saves the new rate', async () => {
    const { q, type, submit, api, ref, toasts } = await setup(AdminInvoiceRateModalComponent);
    expect((q('rate-submit') as HTMLButtonElement).disabled).toBe(true);
    await type('input', '1.1667');
    const compare = q('rate-before-after').textContent ?? '';
    expect(compare).toContain('1%');
    expect(compare).toContain('1.1667%');
    expect(compare).toContain('$19,800');
    expect(compare).toContain('$23,101');
    await submit();
    expect(api.setCommissionRate).toHaveBeenCalledWith('inv-1', 1.1667);
    expect(toasts.show).toHaveBeenCalled();
    expect(ref.close).toHaveBeenCalledWith(true);
  });

  it('rejects an out-of-range rate', async () => {
    const { q, el, type } = await setup(AdminInvoiceRateModalComponent);
    await type('input', '12');
    expect(el.textContent).toContain('Enter a rate above 0% and up to 10%.');
    expect((q('rate-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps a server error inline and stays open', async () => {
    const { el, type, submit, ref } = await setup(AdminInvoiceRateModalComponent, true);
    await type('input', '2');
    await submit();
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    expect(ref.close).not.toHaveBeenCalled();
  });
});

describe('AdminInvoiceMethodModalComponent', () => {
  it('shows the method before → after with the auto-charge consequence', async () => {
    const { q, type, submit, api, ref } = await setup(AdminInvoiceMethodModalComponent);
    expect((q('method-submit') as HTMLButtonElement).disabled).toBe(true);
    await type('select', 'cheque', 'change');
    expect(q('method-before-after').textContent).toContain('Card');
    expect(q('method-before-after').textContent).toContain('Cheque');
    expect(q('method-consequence').textContent).toContain('paused');
    await submit();
    expect(api.setInvoicePaymentMethod).toHaveBeenCalledWith('inv-1', 'cheque');
    expect(ref.close).toHaveBeenCalledWith(true);
  });
});

describe('AdminInvoicePaymentModalComponent', () => {
  it('shows status and balance before → after and records the payment', async () => {
    const { q, type, submit, api, ref } = await setup(AdminInvoicePaymentModalComponent);
    const compare = q('payment-before-after').textContent ?? '';
    expect(compare).toContain('In review');
    expect(compare).toContain('Paid');
    expect(compare).toContain('$19,800');
    expect(compare).toContain('$0');
    expect((q('payment-submit') as HTMLButtonElement).disabled).toBe(true);
    await type('select', 'cheque', 'change');
    await type('input[type="text"], input:not([type])', ' CHQ-123 ');
    await submit();
    expect(api.markInvoicePaid).toHaveBeenCalledWith(
      'inv-1',
      expect.objectContaining({ paymentMethod: 'cheque', reference: 'CHQ-123' }),
    );
    expect(ref.close).toHaveBeenCalledWith(true);
  });

  it('blocks a future paid date', async () => {
    const { q, el, type } = await setup(AdminInvoicePaymentModalComponent);
    await type('select', 'cheque', 'change');
    await type('input[type="date"]', '2999-01-01');
    expect(el.textContent).toContain('can’t be in the future');
    expect((q('payment-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});
