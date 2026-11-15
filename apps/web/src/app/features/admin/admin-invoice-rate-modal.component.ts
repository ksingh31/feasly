import { Component, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { startWith } from 'rxjs';
import { KitMoneyPipe, UiButtonComponent, UiModalComponent, UiTextFieldComponent } from '@app/shared/ui';
import { SetCommissionRate } from './billing-health.actions';
import { AdminInvoiceActionModal } from './admin-invoice-action-modal';
import { invoiceRateLabel, parseInvoiceRate, previewCommissionCents } from './admin-invoice-view';

/**
 * Change rate (#543, review S10): one focused modal for the per-invoice
 * commission-rate override, with the before → after rate and amount
 * (e.g. "$19,800 → $23,100"). The server recalculates on save.
 */
@Component({
  selector: 'app-admin-invoice-rate-modal',
  standalone: true,
  imports: [ReactiveFormsModule, UiModalComponent, UiButtonComponent, UiTextFieldComponent, KitMoneyPipe],
  templateUrl: './admin-invoice-rate-modal.component.html',
  styleUrl: './admin-invoice-modal.scss',
})
export class AdminInvoiceRateModalComponent extends AdminInvoiceActionModal {
  protected readonly rate = new FormControl<string>('', { nonNullable: true });
  private readonly rateText = toSignal(this.rate.valueChanges.pipe(startWith(this.rate.value)), {
    initialValue: '',
  });

  protected readonly beforeRate = invoiceRateLabel(this.invoice.effectiveRatePercent);
  protected readonly newRate = computed(() => parseInvoiceRate(this.rateText()));
  /** Null until a valid rate is typed: the "after" side (and its arrow) stays hidden (#675). */
  protected readonly afterRate = computed(() => {
    const rate = this.newRate();
    return rate === null ? null : invoiceRateLabel(rate);
  });
  protected readonly afterCents = computed(() => {
    const rate = this.newRate();
    return rate === null ? null : previewCommissionCents(this.invoice.contractValueCents, rate);
  });
  protected readonly rateError = computed(() =>
    this.rateText().trim() !== '' && this.newRate() === null ? 'Enter a rate above 0% and up to 10%.' : null,
  );
  protected readonly canSave = computed(
    () =>
      !this.submitting() && this.newRate() !== null && this.newRate() !== this.invoice.effectiveRatePercent,
  );

  protected save(): void {
    const rate = this.newRate();
    if (!this.canSave() || rate === null) return;
    this.run(new SetCommissionRate(this.invoice.id, rate));
  }
}
