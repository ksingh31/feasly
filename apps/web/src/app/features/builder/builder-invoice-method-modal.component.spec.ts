/**
 * Change payment method modal (#533 AC2): before/after, nothing saves
 * until "Save change", closes with the new method, stays open on failure.
 */
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderInvoiceMethodModalComponent } from './builder-invoice-method-modal.component';
import { BuilderInvoicesApiService, type BuilderCommissionInvoice } from './builder-invoices-api.service';
import { BuilderInvoicesState } from './builder-invoices.state';
import type { BuilderPaymentMethod } from './builder-payment-methods';

const COPY = DEFAULT_BUILDER_COPY;
const T = COPY.invoiceDrawer;

function invoice(patch: Partial<BuilderCommissionInvoice> = {}): BuilderCommissionInvoice {
  return {
    id: 'inv-1',
    tenantKey: 't1',
    attributionId: 'a1',
    leadId: 'l1',
    leadName: 'Ava Brown',
    contractValueCents: 68_500_000,
    commissionCents: 685_000,
    currency: 'CAD',
    stripePaymentIntentId: null,
    status: 'finalized',
    reviewDueAt: null,
    finalizedAt: '2026-11-10T00:00:00.000Z',
    paidAt: null,
    slaBreached: false,
    disputeReason: null,
    commissionRateOverride: null,
    commissionRatePercent: 1,
    effectiveRatePercent: 1,
    manualPaymentMethod: null,
    paymentReference: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    invoiceNumber: 'INV-0042',
    paymentMethod: 'card',
    ...patch,
  } as BuilderCommissionInvoice;
}

function setup(options: { fails?: boolean; inv?: BuilderCommissionInvoice } = {}) {
  const inv = options.inv ?? invoice();
  const api = {
    setInvoicePaymentMethod: vi.fn((_id: string, method: BuilderPaymentMethod) =>
      options.fails ? throwError(() => new Error('PUT failed')) : of({ ...inv, paymentMethod: method }),
    ),
  };
  const ref = { close: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [BuilderInvoiceMethodModalComponent],
    providers: [
      { provide: BUILDER_COPY, useValue: COPY },
      { provide: DIALOG_DATA, useValue: { invoice: inv, last4: '4242' } },
      { provide: DialogRef, useValue: ref },
      provideStore([BuilderInvoicesState]),
      { provide: BuilderInvoicesApiService, useValue: api },
    ],
  });
  TestBed.inject(Store);
  const fixture: ComponentFixture<BuilderInvoiceMethodModalComponent> =
    TestBed.createComponent(BuilderInvoiceMethodModalComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const pick = (method: BuilderPaymentMethod) => {
    const radio = el.querySelector(`input[value="${method}"]`) as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  };
  const save = el.querySelector('[data-testid="method-save"]') as HTMLButtonElement;
  return { fixture, el, api, ref, pick, save };
}

const text = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';

describe('BuilderInvoiceMethodModalComponent (#533)', () => {
  it('shows the saved method and its effect as "Now", with a prompt in "After"', () => {
    const { el, save } = setup();
    expect(el.querySelector('.ui-modal__title')?.textContent?.trim()).toBe(T.modalHeading);
    expect(text(el, 'method-before')).toContain('Card •••• 4242');
    expect(text(el, 'method-before')).toContain(T.modalEffectCard);
    expect(text(el, 'method-after')).toContain(T.modalNoChange);
    expect(save.disabled).toBe(true);
  });

  it('lists every method as a radio with the saved one checked and tagged current', () => {
    const { el } = setup();
    const radios = Array.from(el.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['card', 'cheque', 'e_transfer', 'bank_draft']);
    expect(radios.find((r) => r.checked)?.value).toBe('card');
    expect(el.querySelector('.method-modal__tag')?.closest('label')?.textContent).toContain('Card');
  });

  it('previews the picked method in "After" without saving', () => {
    const { el, api, pick, save } = setup();
    pick('cheque');
    expect(text(el, 'method-after')).toContain('Cheque');
    expect(text(el, 'method-after')).toContain('we’ll confirm your cheque payment when it arrives');
    expect(text(el, 'method-before')).toContain('Card •••• 4242');
    expect(api.setInvoicePaymentMethod).not.toHaveBeenCalled();
    expect(save.disabled).toBe(false);
    // Picking the saved method again clears the change.
    pick('card');
    expect(save.disabled).toBe(true);
  });

  it('uses the in-review copy (approved charge-timing sentence) for before/after', () => {
    const { el, pick } = setup({ inv: invoice({ status: 'in_review', reviewDueAt: '2026-11-20T18:00:00.000Z' }) });
    expect(text(el, 'method-before')).toContain('We charge your card 7 days after the invoice is issued.');
    pick('e_transfer');
    expect(text(el, 'method-after')).toContain('pay by e-transfer');
  });

  it('saves the picked method and closes with it', () => {
    const { api, ref, pick, save, fixture } = setup();
    pick('bank_draft');
    save.click();
    fixture.detectChanges();
    expect(api.setInvoicePaymentMethod).toHaveBeenCalledWith('inv-1', 'bank_draft');
    expect(ref.close).toHaveBeenCalledWith('bank_draft');
  });

  it('stays open with the error when the save fails', () => {
    const { el, ref, pick, save, fixture } = setup({ fails: true });
    pick('cheque');
    save.click();
    fixture.detectChanges();
    expect(ref.close).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(COPY.invoicesPaymentMethodSaveFailed);
  });

  it('Cancel closes without saving', () => {
    const { el, api, ref, pick } = setup();
    pick('cheque');
    (el.querySelector('[data-testid="method-cancel"]') as HTMLButtonElement).click();
    expect(ref.close).toHaveBeenCalledWith();
    expect(api.setInvoicePaymentMethod).not.toHaveBeenCalled();
  });
});
