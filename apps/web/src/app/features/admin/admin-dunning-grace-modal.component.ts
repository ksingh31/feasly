import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Store } from '@ngxs/store';
import { finalize, startWith } from 'rxjs';
import { UiButtonComponent, UiModalComponent, UiTextFieldComponent } from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { formatCentsToCad } from '../../shared/utils/money';
import { injectAdminCopy } from './admin-copy';
import { parseGraceDays } from './admin-billing-view';
import { UpdateInvoiceDunning } from './billing-health.actions';
import { BillingHealthState } from './billing-health.state';

/** Data for the grace-days editor: one dunning row. */
export interface AdminDunningGraceModalData {
  readonly invoiceId: string;
  readonly builderName: string;
  readonly commissionCents: number;
  /** The invoice's current grace period; undefined when the API sent none. */
  readonly graceDays: number | undefined;
}

/**
 * #901 "Edit grace days": one focused modal for a dunning invoice's grace
 * period (days between a failed charge and the next automatic retry).
 * Bounds come from config and mirror the API (which stays the authority).
 * Save stays disabled until a valid, different value is typed and while
 * the request is in flight; success closes with the saved number, a
 * failure stays inline.
 */
@Component({
  selector: 'app-admin-dunning-grace-modal',
  standalone: true,
  imports: [ReactiveFormsModule, UiModalComponent, UiButtonComponent, UiTextFieldComponent],
  templateUrl: './admin-dunning-grace-modal.component.html',
  styleUrl: './admin-invoice-modal.scss',
})
export class AdminDunningGraceModalComponent {
  private readonly store = inject(Store);
  private readonly ref = inject<DialogRef<number>>(DialogRef);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly data = inject<AdminDunningGraceModalData>(DIALOG_DATA);
  protected readonly t = injectAdminCopy().dunning;
  private readonly billing = inject(ConfigService).get('billing');
  private readonly min = this.billing.dunningGraceDaysMin;
  private readonly max = this.billing.dunningGraceDaysMax;

  protected readonly days = new FormControl<string>(
    this.data.graceDays === undefined ? '' : String(this.data.graceDays),
    { nonNullable: true },
  );
  private readonly daysText = toSignal(this.days.valueChanges.pipe(startWith(this.days.value)), {
    initialValue: this.days.value,
  });

  protected readonly context = this.fill(this.t.graceContext, {
    builder: this.data.builderName,
    amount: formatCentsToCad(this.data.commissionCents),
  });
  protected readonly hint = this.fill(this.t.graceHint, { min: String(this.min), max: String(this.max) });

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly parsed = computed(() => parseGraceDays(this.daysText(), this.min, this.max));
  protected readonly fieldError = computed(() =>
    this.daysText().trim() !== '' && this.parsed() === null
      ? this.fill(this.t.graceInvalid, { min: String(this.min), max: String(this.max) })
      : null,
  );
  protected readonly canSave = computed(
    () => !this.submitting() && this.parsed() !== null && this.parsed() !== this.data.graceDays,
  );

  protected save(): void {
    const graceDays = this.parsed();
    if (!this.canSave() || graceDays === null) return;
    this.submitting.set(true);
    this.error.set(null);
    this.store
      .dispatch(new UpdateInvoiceDunning(this.data.invoiceId, { action: 'set_grace_days', graceDays }))
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.submitting.set(false)),
      )
      .subscribe({
        complete: () => {
          const feedback = this.store.selectSnapshot(BillingHealthState.dunningFeedback);
          if (feedback?.ok && feedback.invoiceId === this.data.invoiceId) {
            this.ref.close(graceDays);
          } else {
            this.error.set(feedback?.conflict ? this.t.conflictError : this.t.genericError);
          }
        },
      });
  }

  protected cancel(): void {
    this.ref.close();
  }

  private fill(template: string, values: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
  }
}
