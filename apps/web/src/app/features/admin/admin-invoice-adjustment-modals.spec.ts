/**
 * #862 adjustment modals (API #715): Refund… · Void… · Correct contract… ·
 * Reverse payment…. Each shows its before → after, sends the API body,
 * closes with `true` + a toast on success and keeps a server error inline.
 */
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { UiToastService } from '@app/shared/ui';
import type { BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import { AdminBillingApiService } from './admin-billing-api.service';
import { AdminBuildersState } from './admin-builders.state';
import { AdminInvoiceContractModalComponent } from './admin-invoice-contract-modal.component';
import { AdminInvoiceRefundModalComponent } from './admin-invoice-refund-modal.component';
import { AdminInvoiceReverseModalComponent } from './admin-invoice-reverse-modal.component';
import { AdminInvoiceVoidModalComponent } from './admin-invoice-void-modal.component';
import { BillingHealthState } from './billing-health.state';

const PAID = {
  id: 'inv-1',
  tenantKey: 'elite-craft',
  invoiceNumber: 'INV-0042',
  leadName: 'Ava Smith',
  contractValueCents: 198_000_000,
  commissionCents: 1_980_000,
  totalCents: 2_079_000,
  refundedCents: 79_000,
  effectiveRatePercent: 1,
  status: 'paid',
  paymentMethod: 'card',
  manualPaymentMethod: null,
  paymentReference: null,
  stripePaymentIntentId: 'pi_1',
} as unknown as BuilderCommissionInvoice;

const BUILDERS = [{ tenantKey: 'elite-craft', displayName: 'Elite Craft Builders', businessName: 'Elite Craft Builders Inc.' }];

interface Options {
  readonly invoice?: Partial<BuilderCommissionInvoice>;
  /** HTTP-like error the action endpoints answer with. */
  readonly failWith?: { status: number };
}

async function setup<C>(component: Type<C>, options: Options = {}) {
  const invoice = { ...PAID, ...options.invoice } as BuilderCommissionInvoice;
  const answer = <T>(value: T) => (options.failWith ? throwError(() => options.failWith) : of(value));
  const api = {
    getBillingHealth: vi.fn(() => of(null)),
    refundInvoice: vi.fn(() =>
      answer({ invoiceId: 'inv-1', status: 'paid', refundState: 'partially_refunded', replayed: false }),
    ),
    voidInvoice: vi.fn(() => answer({ invoiceId: 'inv-1', status: 'void', previousStatus: 'in_review' })),
    correctContract: vi.fn(() => answer({ invoiceId: 'inv-1', status: 'in_review' })),
    reversePayment: vi.fn(() => answer({ invoiceId: 'inv-1', status: 'failed' })),
  };
  const ref = { close: vi.fn() };
  const toasts = { show: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideStore([BillingHealthState, AdminBuildersState]),
      { provide: AdminBillingApiService, useValue: api },
      { provide: DialogRef, useValue: ref },
      { provide: UiToastService, useValue: toasts },
      { provide: DIALOG_DATA, useValue: { invoice } },
    ],
  });
  const store = TestBed.inject(Store);
  store.reset({
    ...store.snapshot(),
    adminBuilders: { ...store.selectSnapshot((s) => s.adminBuilders), builders: BUILDERS },
  });
  const fixture = TestBed.createComponent(component);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const type = async (selector: string, value: string, event = 'input') => {
    const input = el.querySelector(selector) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    input.value = value;
    input.dispatchEvent(new Event(event));
    await fixture.whenStable();
  };
  const textInputs = () => Array.from(el.querySelectorAll<HTMLInputElement>('input[type="text"], input:not([type])'));
  const typeInto = async (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  const click = async (id: string) => {
    q(id).click();
    await fixture.whenStable();
  };
  return { fixture, el, q, type, textInputs, typeInto, click, api, ref, toasts };
}

describe('AdminInvoiceRefundModalComponent', () => {
  it('starts at the full amount left and shows refunded total and net paid before → after', async () => {
    const { q, textInputs } = await setup(AdminInvoiceRefundModalComponent);
    expect(textInputs()[0].value).toBe('20000.00');
    const compare = q('refund-before-after').textContent ?? '';
    expect(compare).toContain('$790');
    expect(compare).toContain('$20,000');
    expect(q('refund-refunded-after').textContent).toContain('$20,790');
    expect(q('refund-net-after').textContent).toContain('$0');
    expect(q('refund-context').textContent).toContain('Elite Craft Builders');
  });

  it('sends a partial refund with one idempotency key, reused on a retry after an error', async () => {
    const { q, type, textInputs, typeInto, click, api, ref, toasts, el } = await setup(AdminInvoiceRefundModalComponent, {
      failWith: { status: 502 },
    });
    await typeInto(textInputs()[0], '500.50');
    expect(q('refund-refunded-after').textContent).toContain('$1,290.50');
    expect(q('refund-net-after').textContent).toContain('$19,499.50');
    expect((q('refund-submit') as HTMLButtonElement).disabled).toBe(true);
    await type('select', 'billing_error', 'change');
    await type('textarea', ' Wrong rate ');
    await click('refund-submit');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('never refunded twice');
    expect(ref.close).not.toHaveBeenCalled();
    await click('refund-submit');
    expect(api.refundInvoice).toHaveBeenCalledTimes(2);
    const [first, second] = api.refundInvoice.mock.calls as unknown as [[string, { idempotencyKey: string }], [string, { idempotencyKey: string }]];
    expect(first[0]).toBe('inv-1');
    expect(first[1]).toEqual({
      amountCents: 50_050,
      reason: 'billing_error',
      note: 'Wrong rate',
      idempotencyKey: expect.stringMatching(/^refund-/),
    });
    expect(second[1].idempotencyKey).toBe(first[1].idempotencyKey);
    expect(toasts.show).not.toHaveBeenCalled();
  });

  it('locks amount, reason and reference after a failure that may have reached the server', async () => {
    const { q, type, textInputs, typeInto, click, api, el } = await setup(AdminInvoiceRefundModalComponent, {
      failWith: { status: 502 },
    });
    await typeInto(textInputs()[0], '100.00');
    await type('select', 'goodwill', 'change');
    expect(q('refund-locked')).toBeNull();
    await click('refund-submit');
    // The server may already hold the $100 refund under this key.
    expect(textInputs()[0].disabled).toBe(true);
    expect((el.querySelector('select') as HTMLSelectElement).disabled).toBe(true);
    expect(q('refund-locked').textContent).toContain('start a new refund');
    expect(q('refund-submit').textContent).toContain('$100');
    expect((q('refund-submit') as HTMLButtonElement).disabled).toBe(false);
    await click('refund-submit');
    const calls = api.refundInvoice.mock.calls as unknown as Array<[string, { idempotencyKey: string; amountCents: number; reason: string }]>;
    expect(calls).toHaveLength(2);
    expect(calls[1][1].amountCents).toBe(10_000);
    expect(calls[1][1].reason).toBe('goodwill');
    expect(calls[1][1].idempotencyKey).toBe(calls[0][1].idempotencyKey);
  });

  it('keeps the fields editable and starts a new key after a pre-claim 422', async () => {
    const { q, type, textInputs, click, api, el } = await setup(AdminInvoiceRefundModalComponent, {
      failWith: { status: 422 },
    });
    await type('select', 'goodwill', 'change');
    await click('refund-submit');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('can’t exceed');
    expect(textInputs()[0].disabled).toBe(false);
    expect(q('refund-locked')).toBeNull();
    await click('refund-submit');
    const calls = api.refundInvoice.mock.calls as unknown as Array<[string, { idempotencyKey: string }]>;
    expect(calls).toHaveLength(2);
    expect(calls[1][1].idempotencyKey).not.toBe(calls[0][1].idempotencyKey);
  });

  it('tells the admin to start a new refund on a 409 and locks the fields', async () => {
    const { q, type, textInputs, click, el } = await setup(AdminInvoiceRefundModalComponent, {
      failWith: { status: 409 },
    });
    await type('select', 'goodwill', 'change');
    await click('refund-submit');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('start a new refund');
    expect(textInputs()[0].disabled).toBe(true);
    expect(q('refund-locked')).not.toBeNull();
  });

  it('closes with true and toasts on success', async () => {
    const { type, click, api, ref, toasts } = await setup(AdminInvoiceRefundModalComponent);
    await type('select', 'goodwill', 'change');
    await click('refund-submit');
    expect(api.refundInvoice).toHaveBeenCalledWith('inv-1', expect.objectContaining({ amountCents: 2_000_000 }));
    expect(toasts.show).toHaveBeenCalledWith({ message: expect.stringContaining('Partial refund') });
    expect(ref.close).toHaveBeenCalledWith(true);
  });

  it('rejects more than is left to refund', async () => {
    const { q, el, type, textInputs, typeInto } = await setup(AdminInvoiceRefundModalComponent);
    await type('select', 'goodwill', 'change');
    await typeInto(textInputs()[0], '20000.01');
    expect(el.textContent).toContain('no more than what is left');
    expect(q('refund-refunded-after')).toBeNull();
    expect((q('refund-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for the reference when the invoice was paid by hand', async () => {
    const { q, type, textInputs, typeInto, click, api } = await setup(AdminInvoiceRefundModalComponent, {
      invoice: { manualPaymentMethod: 'cheque', stripePaymentIntentId: null },
    });
    expect(textInputs()).toHaveLength(2);
    await type('select', 'duplicate', 'change');
    expect((q('refund-submit') as HTMLButtonElement).disabled).toBe(true);
    await typeInto(textInputs()[1], ' ET-998 ');
    await click('refund-submit');
    expect(api.refundInvoice).toHaveBeenCalledWith('inv-1', expect.objectContaining({ reference: 'ET-998' }));
  });

  it('has no reference field for a card-paid invoice', async () => {
    const { textInputs } = await setup(AdminInvoiceRefundModalComponent);
    expect(textInputs()).toHaveLength(1);
  });
});

describe('AdminInvoiceVoidModalComponent', () => {
  it('shows status and balance before → after and voids with the reason', async () => {
    const { q, type, click, api, ref, toasts } = await setup(AdminInvoiceVoidModalComponent, {
      invoice: { status: 'in_review', refundedCents: 0 },
    });
    const compare = q('void-before-after').textContent ?? '';
    expect(compare).toContain('In review');
    expect(compare).toContain('Void');
    expect(compare).toContain('$20,790');
    expect((q('void-submit') as HTMLButtonElement).disabled).toBe(true);
    await type('select', 'created_in_error', 'change');
    await click('void-submit');
    expect(api.voidInvoice).toHaveBeenCalledWith('inv-1', { reason: 'created_in_error' });
    expect(toasts.show).toHaveBeenCalled();
    expect(ref.close).toHaveBeenCalledWith(true);
  });

  it('keeps a conflict inline', async () => {
    const { el, type, click, ref } = await setup(AdminInvoiceVoidModalComponent, {
      invoice: { status: 'failed' },
      failWith: { status: 409 },
    });
    await type('select', 'duplicate', 'change');
    await type('textarea', 'Second copy');
    await click('void-submit');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('changed state');
    expect(ref.close).not.toHaveBeenCalled();
  });
});

describe('AdminInvoiceContractModalComponent', () => {
  it('previews the new contract value and commission, then sends the correction', async () => {
    const { q, el, type, click, api, ref } = await setup(AdminInvoiceContractModalComponent, {
      invoice: { status: 'in_review' },
    });
    expect(el.textContent).toContain('review window starts again');
    expect(q('contract-value-after')).toBeNull();
    await type('input[inputmode="numeric"]', '1500000');
    expect(q('contract-value-after').textContent).toContain('$1,500,000');
    expect(q('contract-commission-after').textContent).toContain('$15,000');
    expect((q('contract-submit') as HTMLButtonElement).disabled).toBe(true);
    await type('input[type="date"]', '2026-11-02');
    await type('textarea', ' Builder reported the wrong total ');
    await click('contract-submit');
    expect(api.correctContract).toHaveBeenCalledWith('inv-1', {
      contractValueCents: 150_000_000,
      contractSignedAt: expect.stringMatching(/^2026-11-02T00:00:00[+-]\d\d:\d\d$/),
      note: 'Builder reported the wrong total',
    });
    expect(ref.close).toHaveBeenCalledWith(true);
  });

  it('needs a note and blocks a future signing date', async () => {
    const { q, el, type } = await setup(AdminInvoiceContractModalComponent, { invoice: { status: 'draft' } });
    expect(el.textContent).not.toContain('review window starts again');
    await type('input[inputmode="numeric"]', '1500000');
    await type('input[type="date"]', '2999-01-01');
    await type('textarea', 'Typo');
    expect(el.textContent).toContain('can’t be in the future');
    expect((q('contract-submit') as HTMLButtonElement).disabled).toBe(true);
    await type('input[type="date"]', '2026-11-02');
    await type('textarea', '   ');
    expect((q('contract-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('AdminInvoiceReverseModalComponent', () => {
  it('shows paid → failed and the balance due coming back, and needs a reason', async () => {
    const { q, type, click, api, ref } = await setup(AdminInvoiceReverseModalComponent, {
      invoice: { manualPaymentMethod: 'cheque', paymentReference: 'CHQ-77', refundedCents: 0 },
    });
    expect(q('reverse-context').textContent).toContain('Cheque');
    expect(q('reverse-context').textContent).toContain('CHQ-77');
    const compare = q('reverse-before-after').textContent ?? '';
    expect(compare).toContain('Paid');
    expect(compare).toContain('Failed');
    expect(compare).toContain('$20,790');
    expect((q('reverse-submit') as HTMLButtonElement).disabled).toBe(true);
    await type('textarea', ' Cheque bounced ');
    await click('reverse-submit');
    expect(api.reversePayment).toHaveBeenCalledWith('inv-1', { reason: 'Cheque bounced' });
    expect(ref.close).toHaveBeenCalledWith(true);
  });
});
