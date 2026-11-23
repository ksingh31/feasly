import { Component, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { startWith } from 'rxjs';
import type { VoidInvoiceReason, VoidInvoiceRequest } from '@feasly/contracts';
import {
  KitMoneyPipe,
  StatusChipComponent,
  UiButtonComponent,
  UiFieldShellComponent,
  UiModalComponent,
  UiSelectComponent,
  type UiSelectOption,
} from '@app/shared/ui';
import { VoidInvoice } from './billing-health.actions';
import { AdminInvoiceActionModal } from './admin-invoice-action-modal';
import { injectAdminCopy } from './admin-copy';
import { fill } from './admin-leads-view';
import { ADJUSTMENT_NOTE_MAX, VOID_REASON_LABELS } from './admin-invoice-view';

/**
 * Void… (#862, API #715): cancel an invoice that should not be charged
 * (draft, in review, failed). Before → after shows the status and the
 * balance due.
 */
@Component({
  selector: 'app-admin-invoice-void-modal',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    UiModalComponent,
    UiButtonComponent,
    UiSelectComponent,
    UiFieldShellComponent,
    StatusChipComponent,
    KitMoneyPipe,
  ],
  templateUrl: './admin-invoice-void-modal.component.html',
  styleUrl: './admin-invoice-modal.scss',
})
export class AdminInvoiceVoidModalComponent extends AdminInvoiceActionModal {
  protected readonly noteMax = ADJUSTMENT_NOTE_MAX;
  protected readonly t = injectAdminCopy().invoiceAdjustments;
  protected readonly consequence = fill(this.t.voidNote, { builder: this.builderName });
  protected readonly reasons: readonly UiSelectOption[] = VOID_REASON_LABELS.map((o) => ({ ...o }));

  protected readonly form = new FormGroup({
    reason: new FormControl<string | null>(null, { validators: [Validators.required] }),
    note: new FormControl<string>('', { nonNullable: true }),
  });

  private readonly value = toSignal(this.form.valueChanges.pipe(startWith(this.form.getRawValue())), {
    initialValue: this.form.getRawValue(),
  });

  protected readonly noteError = computed(() =>
    (this.value().note ?? '').length > ADJUSTMENT_NOTE_MAX ? fill(this.t.tooLong, { max: ADJUSTMENT_NOTE_MAX }) : null,
  );
  protected readonly canSave = computed(() => !this.submitting() && !!this.value().reason && this.noteError() === null);

  protected onNote(event: Event): void {
    this.form.controls.note.setValue((event.target as HTMLTextAreaElement).value);
  }

  protected save(): void {
    const { reason, note } = this.form.getRawValue();
    if (!this.canSave() || !reason) return;
    const trimmed = note.trim();
    const body: VoidInvoiceRequest = {
      reason: reason as VoidInvoiceReason,
      ...(trimmed ? { note: trimmed } : {}),
    };
    this.run(new VoidInvoice(this.invoice.id, body));
  }
}
