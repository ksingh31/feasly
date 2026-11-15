import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { DestroyRef, Directive, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { finalize } from 'rxjs';
import { UiToastService } from '@app/shared/ui';
import type { BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import { DismissInvoiceFeedback } from './billing-health.actions';
import { BillingHealthState } from './billing-health.state';

/** Data handed to each invoice action modal. */
export interface AdminInvoiceActionData {
  readonly invoice: BuilderCommissionInvoice;
}

/**
 * Shared plumbing for the three intent-specific invoice modals (#543,
 * review S10): Change rate · Change payment method · Record payment.
 *
 * Each modal shows its own before → after and consequence text; this base
 * dispatches the existing BillingHealth action, keeps the submit button
 * disabled until the request settles (no double money actions), and on
 * success toasts the server's message and closes with `true` so the
 * drawer refreshes. A failure stays in the modal as an inline alert.
 */
@Directive()
export abstract class AdminInvoiceActionModal {
  protected readonly store = inject(Store);
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  private readonly toasts = inject(UiToastService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly invoice = inject<AdminInvoiceActionData>(DIALOG_DATA).invoice;

  /** A request is in flight — the submit button stays disabled. */
  protected readonly submitting = signal(false);
  /** Server error for the last attempt, shown inline. */
  protected readonly error = signal<string | null>(null);

  protected run(action: object): void {
    if (this.submitting()) return;
    this.submitting.set(true);
    this.error.set(null);
    this.store
      .dispatch(action)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.submitting.set(false)),
      )
      .subscribe({
        complete: () => {
          const feedback = this.store.selectSnapshot(BillingHealthState.invoiceFeedback);
          this.store.dispatch(new DismissInvoiceFeedback());
          if (feedback?.ok) {
            this.toasts.show({ message: feedback.message });
            this.ref.close(true);
          } else {
            this.error.set(feedback?.message ?? 'Something went wrong. Please try again.');
          }
        },
      });
  }

  protected cancel(): void {
    this.ref.close(false);
  }
}
