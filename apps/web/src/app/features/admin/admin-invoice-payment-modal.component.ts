import { Component, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { startWith } from 'rxjs';
import type { ManualPaymentMethod, MarkInvoicePaidRequest } from '@feasly/contracts';
import {
  KitMoneyPipe,
  StatusChipComponent,
  UiButtonComponent,
  UiDateFieldComponent,
  UiModalComponent,
  UiSelectComponent,
  type UiSelectOption,
  UiTextFieldComponent,
} from '@app/shared/ui';
import { dateOnlyToIsoWithOffset, todayLocalDateString } from '../../shared/utils/datetime';
import { MarkInvoicePaid } from './billing-health.actions';
import { MANUAL_PAYMENT_METHOD_LABELS } from './admin-billing-api.service';
import { AdminInvoiceActionModal } from './admin-invoice-action-modal';

/** Longest payment reference the backend accepts. */
const REFERENCE_MAX = 120;

/**
 * Record payment (#543, review S10): an off-Stripe payment for one
 * invoice. Before → after shows the status and balance due; saving marks
 * the invoice paid AND cancels the scheduled auto-charge, so the builder
 * can never be charged twice.
 */
@Component({
  selector: 'app-admin-invoice-payment-modal',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    UiModalComponent,
    UiButtonComponent,
    UiSelectComponent,
    UiTextFieldComponent,
    UiDateFieldComponent,
    StatusChipComponent,
    KitMoneyPipe,
  ],
  templateUrl: './admin-invoice-payment-modal.component.html',
  styleUrl: './admin-invoice-modal.scss',
})
export class AdminInvoicePaymentModalComponent extends AdminInvoiceActionModal {
  protected readonly options: readonly UiSelectOption[] = MANUAL_PAYMENT_METHOD_LABELS.map((o) => ({
    value: o.value,
    label: o.label,
  }));
  protected readonly today = todayLocalDateString();

  protected readonly form = new FormGroup({
    method: new FormControl<string | null>(null, { validators: [Validators.required] }),
    reference: new FormControl<string>('', { nonNullable: true, validators: [Validators.maxLength(REFERENCE_MAX)] }),
    paidDate: new FormControl<string | null>(this.today, { validators: [Validators.required] }),
  });

  private readonly value = toSignal(this.form.valueChanges.pipe(startWith(this.form.getRawValue())), {
    initialValue: this.form.getRawValue(),
  });

  /** A payment can't arrive in the future (same rule as before). */
  protected readonly dateError = computed(() => {
    const date = this.value().paidDate;
    return date && date > this.today ? 'The paid date can’t be in the future.' : null;
  });
  protected readonly referenceError = computed(() =>
    (this.value().reference ?? '').length > REFERENCE_MAX ? `Keep it under ${REFERENCE_MAX} characters.` : null,
  );
  protected readonly canSave = computed(() => {
    const v = this.value();
    return (
      !this.submitting() && !!v.method && !!v.paidDate && this.dateError() === null && this.referenceError() === null
    );
  });

  protected save(): void {
    if (!this.canSave()) return;
    const { method, reference, paidDate } = this.form.getRawValue();
    if (!method || !paidDate) return;
    const body: MarkInvoicePaidRequest = {
      paymentMethod: method as ManualPaymentMethod,
      paidAt: dateOnlyToIsoWithOffset(paidDate),
    };
    const trimmed = reference.trim();
    this.run(new MarkInvoicePaid(this.invoice.id, trimmed.length > 0 ? { ...body, reference: trimmed } : body));
  }
}
