import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { UiButtonComponent, UiModalComponent } from '@app/shared/ui';
import { BUILDER_COPY } from './builder-copy';
import { methodEffect, methodLabel } from './builder-invoice-view';
import { UpdateInvoicePaymentMethod } from './builder-invoices.actions';
import { BuilderInvoicesState } from './builder-invoices.state';
import type { BuilderCommissionInvoice } from './builder-invoices-api.service';
import { BUILDER_PAYMENT_METHODS, isBuilderPaymentMethod, type BuilderPaymentMethod } from './builder-payment-methods';

export interface BuilderInvoiceMethodModalData {
  readonly invoice: BuilderCommissionInvoice;
  /** Card-on-file last4 for the card label; null when unknown. */
  readonly last4: string | null;
}

/**
 * Change payment method modal (#533, builder review Should-fix 4): opened
 * from the invoice drawer's "Change" link. Shows the saved method and what
 * it does ("Now") beside the picked method and what it will do ("After
 * this change"). Nothing saves until "Save change" (Karan 2026-10-02: no
 * auto-save on select). Closes with the new method on success; a failed
 * save stays open with the error inline.
 */
@Component({
  selector: 'app-builder-invoice-method-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiModalComponent, UiButtonComponent],
  templateUrl: './builder-invoice-method-modal.component.html',
  styleUrl: './builder-invoice-method-modal.component.scss',
})
export class BuilderInvoiceMethodModalComponent {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly ref = inject<DialogRef<BuilderPaymentMethod, BuilderInvoiceMethodModalComponent>>(DialogRef);
  private readonly data = inject<BuilderInvoiceMethodModalData>(DIALOG_DATA);

  protected readonly copy = inject(BUILDER_COPY);
  protected readonly t = this.copy.invoiceDrawer;
  protected readonly invoice = this.data.invoice;
  protected readonly methods = BUILDER_PAYMENT_METHODS;
  protected readonly current = this.invoice.paymentMethod;

  protected readonly picked = signal<BuilderPaymentMethod>(this.current);
  protected readonly saving = signal(false);
  protected readonly failed = signal(false);

  protected readonly changed = computed(() => this.picked() !== this.current);

  protected readonly beforeLabel = this.label(this.current);
  protected readonly beforeEffect = methodEffect(this.invoice, this.current, this.copy, this.data.last4);
  protected readonly afterLabel = computed(() => (this.changed() ? this.label(this.picked()) : null));
  protected readonly afterEffect = computed(() =>
    this.changed() ? methodEffect(this.invoice, this.picked(), this.copy, this.data.last4) : this.t.modalNoChange,
  );

  protected label(method: BuilderPaymentMethod): string {
    return methodLabel(method, this.copy, this.data.last4);
  }

  protected onPick(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (!isBuilderPaymentMethod(value)) return;
    this.failed.set(false);
    this.picked.set(value);
  }

  protected cancel(): void {
    this.ref.close();
  }

  protected save(): void {
    const method = this.picked();
    if (!this.changed() || this.saving()) return;
    this.saving.set(true);
    this.failed.set(false);
    this.store
      .dispatch(new UpdateInvoicePaymentMethod(this.invoice.id, method))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.saving.set(false);
        if (this.store.selectSnapshot(BuilderInvoicesState.paymentMethodSaveStatus) === 'error') {
          this.failed.set(true);
          return;
        }
        this.ref.close(method);
      });
  }
}
