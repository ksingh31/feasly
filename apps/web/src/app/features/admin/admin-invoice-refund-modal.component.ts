import { Component, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { startWith } from 'rxjs';
import type { InvoiceRefundReason, RefundInvoiceRequest } from '@feasly/contracts';
import {
  KitMoneyPipe,
  UiButtonComponent,
  UiFieldShellComponent,
  UiModalComponent,
  UiSelectComponent,
  type UiSelectOption,
  UiTextFieldComponent,
} from '@app/shared/ui';
import { formatCentsToCad, parseCadDollarsToCents } from '../../shared/utils/money';
import { RefundInvoice } from './billing-health.actions';
import { AdminInvoiceActionModal } from './admin-invoice-action-modal';
import { injectAdminCopy } from './admin-copy';
import { fill } from './admin-leads-view';
import {
  ADJUSTMENT_NOTE_MAX,
  REFUND_REASON_LABELS,
  REFUND_REFERENCE_MAX,
  centsToDollarInput,
  newRefundIdempotencyKey,
  refundNeedsReference,
  refundPreview,
  refundableCents,
} from './admin-invoice-view';

/**
 * Refund… (#862, API #715): refund a paid invoice in full or in part.
 * Before → after shows the refunded total and the net the platform keeps.
 * One idempotency key is generated per modal open and sent on every
 * attempt, so a double-click or a retry after an error never refunds twice.
 */
@Component({
  selector: 'app-admin-invoice-refund-modal',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    UiModalComponent,
    UiButtonComponent,
    UiSelectComponent,
    UiTextFieldComponent,
    UiFieldShellComponent,
    KitMoneyPipe,
  ],
  templateUrl: './admin-invoice-refund-modal.component.html',
  styleUrl: './admin-invoice-modal.scss',
})
export class AdminInvoiceRefundModalComponent extends AdminInvoiceActionModal {
  /** One key per modal open — reused on retries and double-clicks. */
  readonly idempotencyKey = newRefundIdempotencyKey();
  protected readonly t = injectAdminCopy().invoiceAdjustments;

  protected readonly noteMax = ADJUSTMENT_NOTE_MAX;
  protected readonly left = refundableCents(this.invoice);
  protected readonly needsReference = refundNeedsReference(this.invoice);
  protected readonly reasons: readonly UiSelectOption[] = REFUND_REASON_LABELS.map((o) => ({ ...o }));
  protected readonly amountHint = fill(this.t.refundAmountHint, { amount: formatCentsToCad(this.left) });
  protected readonly methodNote = this.needsReference
    ? this.t.refundManualNote
    : fill(this.t.refundCardNote, { builder: this.builderName });
  private readonly tooLong = (max: number) => fill(this.t.tooLong, { max });

  protected readonly form = new FormGroup({
    amount: new FormControl<string>(centsToDollarInput(this.left), { nonNullable: true }),
    reason: new FormControl<string | null>(null, { validators: [Validators.required] }),
    reference: new FormControl<string>('', { nonNullable: true }),
    note: new FormControl<string>('', { nonNullable: true }),
  });

  private readonly value = toSignal(this.form.valueChanges.pipe(startWith(this.form.getRawValue())), {
    initialValue: this.form.getRawValue(),
  });

  protected readonly amountCents = computed(() => parseCadDollarsToCents(this.value().amount ?? ''));
  protected readonly preview = computed(() => refundPreview(this.invoice, this.amountCents()));
  protected readonly isFull = computed(() => this.amountCents() === this.left);

  protected readonly amountError = computed(() => {
    const raw = (this.value().amount ?? '').trim();
    if (raw === '') return this.t.refundAmountRequired;
    return this.preview() === null ? this.t.refundAmountInvalid : null;
  });
  protected readonly referenceError = computed(() => {
    const ref = (this.value().reference ?? '').trim();
    return ref.length > REFUND_REFERENCE_MAX ? this.tooLong(REFUND_REFERENCE_MAX) : null;
  });
  protected readonly noteError = computed(() =>
    (this.value().note ?? '').length > ADJUSTMENT_NOTE_MAX ? this.tooLong(ADJUSTMENT_NOTE_MAX) : null,
  );

  protected readonly canSave = computed(() => {
    const v = this.value();
    return (
      !this.submitting() &&
      this.preview() !== null &&
      !!v.reason &&
      (!this.needsReference || (v.reference ?? '').trim().length > 0) &&
      this.referenceError() === null &&
      this.noteError() === null
    );
  });

  protected onNote(event: Event): void {
    this.form.controls.note.setValue((event.target as HTMLTextAreaElement).value);
  }

  protected save(): void {
    const amountCents = this.amountCents();
    const { reason, reference, note } = this.form.getRawValue();
    if (!this.canSave() || amountCents === null || !reason) return;
    const trimmedNote = note.trim();
    const trimmedRef = reference.trim();
    const body: RefundInvoiceRequest = {
      amountCents,
      reason: reason as InvoiceRefundReason,
      idempotencyKey: this.idempotencyKey,
      ...(trimmedNote ? { note: trimmedNote } : {}),
      ...(this.needsReference && trimmedRef ? { reference: trimmedRef } : {}),
    };
    this.run(new RefundInvoice(this.invoice.id, body));
  }
}
