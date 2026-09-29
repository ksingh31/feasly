import {
  Component,
  DestroyRef,
  EventEmitter,
  OnDestroy,
  Output,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { startWith } from 'rxjs';
import { Store } from '@ngxs/store';
import type {
  ManualPaymentMethod,
  MarkInvoicePaidRequest,
  MarkInvoicePaidResponse,
  SetCommissionRateResponse,
} from '@feasly/contracts';
import { formatCentsToCad } from '../../shared/utils/money';
import {
  dateOnlyToIsoWithOffset,
  todayLocalDateString,
} from '../../shared/utils/datetime';
import { BillingHealthState } from './billing-health.state';
import {
  DismissInvoiceFeedback,
  MarkInvoicePaid,
  SetCommissionRate,
} from './billing-health.actions';
import {
  MANUAL_PAYMENT_METHOD_LABELS,
} from './admin-billing-api.service';

/**
 * Invoice handed to the manage modal — either an in-review work-queue
 * row or a dunning row. Both carry the effective rate and the contract
 * value so the rate preview is exact.
 */
export interface ManageInvoiceInput {
  readonly id: string;
  readonly tenantKey: string;
  readonly commissionCents: number;
  readonly currency: string;
  readonly commissionRatePercent: number;
  readonly contractValueCents: number;
  readonly reviewDueAt: string | null;
  readonly status: 'in_review' | 'failed';
}

/** Rate must be strictly positive; the server also enforces rate <= 10. */
function greaterThanZero(
  control: AbstractControl<number | null>,
): ValidationErrors | null {
  const value = control.value;
  return typeof value === 'number' && value > 0 ? null : { greaterThanZero: true };
}

/** True for a rate-override result (it carries the recalculated amount). */
function isRateResponse(
  confirmed: MarkInvoicePaidResponse | SetCommissionRateResponse,
): confirmed is SetCommissionRateResponse {
  return !('paymentMethod' in confirmed);
}

/**
 * Manage-invoice panel for /admin/billing — the admin-only work queue
 * actions for one commission invoice. Never rendered in the builder
 * portal.
 *
 * Two independent money actions, each with a deliberate two-click
 * confirm (the BILL-03 retry pattern):
 * - Commission rate: shows the current effective rate, a live
 *   recalculated-amount preview from the signed contract value
 *   (excluding land), then "Update rate" → "Confirm update rate".
 * - Record payment: method dropdown, optional reference, paid date
 *   (defaults to today). "Mark as paid" → "Confirm mark paid".
 *   Confirming marks the invoice paid AND cancels the scheduled
 *   auto-charge — the builder can never be charged twice.
 *
 * Success shows the server's authoritative figures with a Done button;
 * the state reloads the dashboard payload so the work queue refreshes.
 */
@Component({
  selector: 'app-admin-manage-invoice',
  standalone: true,
  imports: [ReactiveFormsModule, DatePipe],
  templateUrl: './admin-manage-invoice.component.html',
  styleUrl: './admin-manage-invoice.component.scss',
})
export class AdminManageInvoiceComponent implements OnDestroy {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  @Output() readonly closed = new EventEmitter<void>();

  readonly invoice = input.required<ManageInvoiceInput>();

  readonly actionStatus = this.store.selectSignal(
    BillingHealthState.invoiceActionStatus,
  );
  readonly feedback = this.store.selectSignal(
    BillingHealthState.invoiceFeedback,
  );

  /** Payment-method options for the dropdown. */
  protected readonly paymentMethods = MANUAL_PAYMENT_METHOD_LABELS;

  /** "Update rate" armed — the deliberate second click. */
  readonly confirmingRate = signal(false);
  /** "Mark as paid" armed — the deliberate second click. */
  readonly confirmingPaid = signal(false);

  readonly rateForm = new FormGroup({
    rate: new FormControl<number | null>(null, {
      validators: [
        Validators.required,
        greaterThanZero,
        Validators.max(10),
      ],
    }),
  });

  readonly payForm = new FormGroup({
    method: new FormControl<ManualPaymentMethod | ''>('', {
      validators: [Validators.required],
      nonNullable: true,
    }),
    reference: new FormControl<string>('', {
      validators: [Validators.maxLength(120)],
      nonNullable: true,
    }),
    paidDate: new FormControl<string>(todayLocalDateString(), {
      validators: [Validators.required],
      nonNullable: true,
    }),
  });

  /**
   * Live recalculated commission for the entered rate. Tracked through
   * `valueChanges` because `FormControl.value` is a plain property read, not
   * a signal — a computed reading it directly would never re-evaluate.
   */
  private readonly rateValue = toSignal(
    this.rateForm.controls.rate.valueChanges.pipe(
      startWith(this.rateForm.controls.rate.value),
    ),
    { initialValue: null as number | null },
  );

  /** Live recalculated commission for the entered rate. */
  readonly previewCents = computed(() => {
    const rate = this.rateValue();
    if (rate === null || !Number.isFinite(rate) || rate <= 0 || rate > 10) {
      return null;
    }
    return Math.round((this.invoice().contractValueCents * rate) / 100);
  });

  /** Server-confirmed result after a successful action. */
  readonly confirmedInvoice = computed(
    () => this.feedback()?.invoice ?? null,
  );

  /** True when the confirmed result is a mark-paid (no recalculated amount). */
  readonly confirmedPaid = computed(() => {
    const confirmed = this.confirmedInvoice();
    return confirmed !== null && !isRateResponse(confirmed);
  });

  /** Authoritative figures from the confirmed server response. */
  readonly confirmedCommissionCents = computed(() => {
    const confirmed = this.confirmedInvoice();
    return confirmed !== null && isRateResponse(confirmed)
      ? confirmed.commissionCents
      : 0;
  });
  readonly confirmedRatePercent = computed(() => {
    const confirmed = this.confirmedInvoice();
    return confirmed !== null && isRateResponse(confirmed)
      ? confirmed.commissionRatePercent
      : null;
  });

  ngOnDestroy(): void {
    this.store.dispatch(new DismissInvoiceFeedback());
  }

  formatCad(cents: number): string {
    return formatCentsToCad(cents);
  }

  formatRatePercent(rate: number): string {
    return `${Number(rate.toFixed(4))}%`;
  }

  statusLabel(): string {
    return this.invoice().status === 'in_review' ? 'In review' : 'Failed charge';
  }

  paymentMethodLabel(method: ManualPaymentMethod | ''): string {
    return (
      this.paymentMethods.find((option) => option.value === method)?.label ??
      method
    );
  }

  /** First click: arm the rate confirm (validates the rate first). */
  startRateConfirm(): void {
    this.rateForm.markAllAsTouched();
    if (this.rateForm.invalid) return;
    this.confirmingRate.set(true);
  }

  backFromRateConfirm(): void {
    this.confirmingRate.set(false);
  }

  /** The deliberate second click: dispatch the rate override. */
  confirmRateUpdate(): void {
    const rate = this.rateForm.controls.rate.value;
    if (rate === null || rate <= 0 || rate > 10) return;
    this.confirmingRate.set(false);
    this.store
      .dispatch(new SetCommissionRate(this.invoice().id, rate))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** First click: arm the mark-paid confirm (validates first). */
  startPaidConfirm(): void {
    this.payForm.markAllAsTouched();
    if (this.payForm.invalid) return;
    this.confirmingPaid.set(true);
  }

  backFromPaidConfirm(): void {
    this.confirmingPaid.set(false);
  }

  /** The deliberate second click: record the payment. */
  confirmMarkPaid(): void {
    const { method, reference, paidDate } = this.payForm.getRawValue();
    if (method === '' || paidDate === '') return;
    const body: MarkInvoicePaidRequest = {
      paymentMethod: method,
      paidAt: dateOnlyToIsoWithOffset(paidDate),
    };
    const trimmed = reference.trim();
    this.confirmingPaid.set(false);
    this.store
      .dispatch(
        new MarkInvoicePaid(
          this.invoice().id,
          trimmed.length > 0 ? { ...body, reference: trimmed } : body,
        ),
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  close(): void {
    this.store.dispatch(new DismissInvoiceFeedback());
    this.closed.emit();
  }
}
