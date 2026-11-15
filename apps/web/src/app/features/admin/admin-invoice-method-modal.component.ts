import { Component, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { startWith } from 'rxjs';
import type { BuilderPaymentMethod } from '@feasly/contracts';
import { UiButtonComponent, UiModalComponent, UiSelectComponent, type UiSelectOption } from '@app/shared/ui';
import { SetInvoicePlannedPaymentMethod } from './billing-health.actions';
import { PLANNED_PAYMENT_METHOD_LABELS } from './admin-billing-api.service';
import { AdminInvoiceActionModal } from './admin-invoice-action-modal';
import { methodConsequence, plannedMethodLabel } from './admin-invoice-view';

/**
 * Change payment method (#543, review S10): the planned method for one
 * unpaid invoice, with before → after and what happens to the Stripe
 * auto-charge.
 */
@Component({
  selector: 'app-admin-invoice-method-modal',
  standalone: true,
  imports: [ReactiveFormsModule, UiModalComponent, UiButtonComponent, UiSelectComponent],
  templateUrl: './admin-invoice-method-modal.component.html',
  styleUrl: './admin-invoice-modal.scss',
})
export class AdminInvoiceMethodModalComponent extends AdminInvoiceActionModal {
  protected readonly options: readonly UiSelectOption[] = PLANNED_PAYMENT_METHOD_LABELS.map((o) => ({
    value: o.value,
    label: o.label,
  }));
  protected readonly method = new FormControl<string | null>(this.invoice.paymentMethod);
  private readonly selected = toSignal(this.method.valueChanges.pipe(startWith(this.method.value)), {
    initialValue: this.invoice.paymentMethod as string | null,
  });

  protected readonly before = plannedMethodLabel(this.invoice.paymentMethod);
  protected readonly after = computed(() => plannedMethodLabel(this.selected() ?? ''));
  protected readonly changed = computed(() => {
    const value = this.selected();
    return value !== null && value !== '' && value !== this.invoice.paymentMethod;
  });
  protected readonly consequence = computed(() =>
    this.changed() ? methodConsequence(this.selected() as BuilderPaymentMethod) : null,
  );
  protected readonly canSave = computed(() => !this.submitting() && this.changed());

  protected save(): void {
    if (!this.canSave()) return;
    this.run(new SetInvoicePlannedPaymentMethod(this.invoice.id, this.selected() as BuilderPaymentMethod));
  }
}
