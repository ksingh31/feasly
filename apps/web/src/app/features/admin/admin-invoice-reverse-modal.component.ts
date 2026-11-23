import { Component, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { startWith } from 'rxjs';
import {
  KitMoneyPipe,
  StatusChipComponent,
  UiButtonComponent,
  UiFieldShellComponent,
  UiModalComponent,
} from '@app/shared/ui';
import { ReverseInvoicePayment } from './billing-health.actions';
import { AdminInvoiceActionModal } from './admin-invoice-action-modal';
import { injectAdminCopy } from './admin-copy';
import { fill } from './admin-leads-view';
import { ADJUSTMENT_NOTE_MAX, manualMethodLabel } from './admin-invoice-view';

/**
 * Reverse payment… (#862, API #715): undo a manual mark-paid when the
 * money never arrived (a bounced cheque). Before → after shows the status
 * (paid → failed) and the balance due; nothing is charged automatically.
 */
@Component({
  selector: 'app-admin-invoice-reverse-modal',
  standalone: true,
  imports: [ReactiveFormsModule, UiModalComponent, UiButtonComponent, UiFieldShellComponent, StatusChipComponent, KitMoneyPipe],
  templateUrl: './admin-invoice-reverse-modal.component.html',
  styleUrl: './admin-invoice-modal.scss',
})
export class AdminInvoiceReverseModalComponent extends AdminInvoiceActionModal {
  protected readonly reasonMax = ADJUSTMENT_NOTE_MAX;
  protected readonly t = injectAdminCopy().invoiceAdjustments;
  protected readonly method = this.invoice.manualPaymentMethod
    ? manualMethodLabel(this.invoice.manualPaymentMethod)
    : '—';

  protected readonly reason = new FormControl<string>('', { nonNullable: true });
  private readonly reasonText = toSignal(this.reason.valueChanges.pipe(startWith(this.reason.value)), {
    initialValue: '',
  });

  protected readonly reasonError = computed(() =>
    this.reasonText().length > ADJUSTMENT_NOTE_MAX ? fill(this.t.tooLong, { max: ADJUSTMENT_NOTE_MAX }) : null,
  );
  protected readonly canSave = computed(
    () => !this.submitting() && this.reasonText().trim().length > 0 && this.reasonError() === null,
  );

  protected onReason(event: Event): void {
    this.reason.setValue((event.target as HTMLTextAreaElement).value);
  }

  protected save(): void {
    if (!this.canSave()) return;
    this.run(new ReverseInvoicePayment(this.invoice.id, { reason: this.reason.value.trim() }));
  }
}
