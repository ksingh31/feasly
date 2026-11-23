import { Component, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { startWith } from 'rxjs';
import type { CorrectContractRequest } from '@feasly/contracts';
import {
  KitMoneyPipe,
  UiButtonComponent,
  UiDateFieldComponent,
  UiFieldShellComponent,
  UiModalComponent,
  UiMoneyFieldComponent,
} from '@app/shared/ui';
import { dateOnlyToIsoWithOffset, todayLocalDateString } from '../../shared/utils/datetime';
import { CorrectInvoiceContract } from './billing-health.actions';
import { AdminInvoiceActionModal } from './admin-invoice-action-modal';
import { injectAdminCopy } from './admin-copy';
import { fill } from './admin-leads-view';
import { ADJUSTMENT_NOTE_MAX, invoiceRateLabel, previewCommissionCents } from './admin-invoice-view';

/**
 * Correct contract… (#862, API #715): fix the reported contract on an
 * invoice that has not been charged (draft, in review). Before → after
 * shows the contract value and a preview of the commission at this
 * invoice's own rate; the server recalculates commission and tax on save.
 */
@Component({
  selector: 'app-admin-invoice-contract-modal',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    UiModalComponent,
    UiButtonComponent,
    UiMoneyFieldComponent,
    UiDateFieldComponent,
    UiFieldShellComponent,
    KitMoneyPipe,
  ],
  templateUrl: './admin-invoice-contract-modal.component.html',
  styleUrl: './admin-invoice-modal.scss',
})
export class AdminInvoiceContractModalComponent extends AdminInvoiceActionModal {
  protected readonly noteMax = ADJUSTMENT_NOTE_MAX;
  protected readonly today = todayLocalDateString();
  protected readonly rate = invoiceRateLabel(this.invoice.effectiveRatePercent);
  protected readonly inReview = this.invoice.status === 'in_review';
  protected readonly t = injectAdminCopy().invoiceAdjustments;
  protected readonly reviewNote = fill(this.t.contractReviewNote, { builder: this.builderName });

  protected readonly form = new FormGroup({
    contractValueCents: new FormControl<number | null>(null, { validators: [Validators.required] }),
    signedDate: new FormControl<string | null>(null, { validators: [Validators.required] }),
    note: new FormControl<string>('', { nonNullable: true }),
  });

  private readonly value = toSignal(this.form.valueChanges.pipe(startWith(this.form.getRawValue())), {
    initialValue: this.form.getRawValue(),
  });

  protected readonly newValueCents = computed(() => {
    const cents = this.value().contractValueCents;
    return typeof cents === 'number' && cents > 0 ? cents : null;
  });
  protected readonly afterCommission = computed(() => {
    const cents = this.newValueCents();
    return cents === null ? null : previewCommissionCents(cents, this.invoice.effectiveRatePercent);
  });
  protected readonly dateError = computed(() => {
    const date = this.value().signedDate;
    return date && date > this.today ? 'The signing date can’t be in the future.' : null;
  });
  protected readonly noteError = computed(() =>
    (this.value().note ?? '').length > ADJUSTMENT_NOTE_MAX ? fill(this.t.tooLong, { max: ADJUSTMENT_NOTE_MAX }) : null,
  );
  protected readonly canSave = computed(() => {
    const v = this.value();
    return (
      !this.submitting() &&
      this.newValueCents() !== null &&
      !!v.signedDate &&
      this.dateError() === null &&
      (v.note ?? '').trim().length > 0 &&
      this.noteError() === null
    );
  });

  protected onNote(event: Event): void {
    this.form.controls.note.setValue((event.target as HTMLTextAreaElement).value);
  }

  protected save(): void {
    const cents = this.newValueCents();
    const { signedDate, note } = this.form.getRawValue();
    if (!this.canSave() || cents === null || !signedDate) return;
    const body: CorrectContractRequest = {
      contractValueCents: cents,
      contractSignedAt: dateOnlyToIsoWithOffset(signedDate),
      note: note.trim(),
    };
    this.run(new CorrectInvoiceContract(this.invoice.id, body));
  }
}
