import {
  Component,
  DestroyRef,
  EventEmitter,
  OnDestroy,
  OnInit,
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
import { finalize, startWith } from 'rxjs';
import { Store } from '@ngxs/store';
import type {
  AdminSetInvoicePaymentMethodResponse,
  BuilderPaymentMethod,
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
  SetInvoicePlannedPaymentMethod,
} from './billing-health.actions';
import {
  MANUAL_PAYMENT_METHOD_LABELS,
  PLANNED_PAYMENT_METHOD_LABELS,
} from './admin-billing-api.service';

/**
 * Invoice handed to the manage modal — either an in-review work-queue
 * row or a dunning row. Both carry the effective rate, the contract
 * value, and the planned payment method so the modal sections render
 * without a second fetch.
 */
export interface ManageInvoiceInput {
  readonly id: string;
  readonly tenantKey: string;
  readonly commissionCents: number;
  readonly currency: string;
  readonly commissionRatePercent: number;
  readonly contractValueCents: number;
  readonly paymentMethod: BuilderPaymentMethod;
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

/** The confirmed result carries one of three server shapes. */
type ConfirmedInvoiceResult =
  | MarkInvoicePaidResponse
  | SetCommissionRateResponse
  | AdminSetInvoicePaymentMethodResponse;

/** True for a mark-paid result (it carries paidAt). */
function isMarkPaidResponse(
  confirmed: ConfirmedInvoiceResult,
): confirmed is MarkInvoicePaidResponse {
  return 'paidAt' in confirmed;
}

/** True for a rate-override result (it carries the recalculated amount). */
function isRateResponse(
  confirmed: ConfirmedInvoiceResult,
): confirmed is SetCommissionRateResponse {
  return 'commissionCents' in confirmed;
}

/** True for a planned-payment-method result (method, no paidAt). */
function isPlannedMethodResponse(
  confirmed: ConfirmedInvoiceResult,
): confirmed is AdminSetInvoicePaymentMethodResponse {
  return 'paymentMethod' in confirmed && !('paidAt' in confirmed);
}

/**
 * Manage-invoice modal for /admin/billing — the admin-only work queue
 * actions for one commission invoice. Never rendered in the builder
 * portal. Opened from the billing page's Manage button (modal shell lives
 * in admin-billing); Esc and backdrop clicks close it.
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
 * - Planned payment method: pre-populated with the current method,
 *   "Update method" → "Confirm update method". Choosing a manual method
 *   pauses the Stripe auto-charge until staff records the payment; going
 *   back to card re-arms it. Unpaid invoices only — once paid, the method
 *   is the historical payment method and the section is locked.
 *
 * Every action button is disabled from the first click until the request
 * settles (the `inflight` signal, fed by the store's `submitting` status),
 * so double-clicks and repeated Enters can never fire a money action
 * twice. Success shows the server's authoritative figures with a Done
 * button; the state reloads the dashboard payload so the work queue
 * refreshes.
 */
@Component({
  selector: 'app-admin-manage-invoice',
  standalone: true,
  imports: [ReactiveFormsModule, DatePipe],
  templateUrl: './admin-manage-invoice.component.html',
  styleUrl: './admin-manage-invoice.component.scss',
})
export class AdminManageInvoiceComponent implements OnInit, OnDestroy {
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

  /** Payment-method options for the record-payment dropdown. */
  protected readonly paymentMethods = MANUAL_PAYMENT_METHOD_LABELS;

  /** Planned payment-method options for the change-method dropdown. */
  protected readonly plannedMethodOptions = PLANNED_PAYMENT_METHOD_LABELS;

  /** "Update rate" armed — the deliberate second click. */
  readonly confirmingRate = signal(false);
  /** "Mark as paid" armed — the deliberate second click. */
  readonly confirmingPaid = signal(false);
  /** "Update method" armed — the deliberate second click. */
  readonly confirmingMethod = signal(false);

  /**
   * Which money action currently has a request in flight. The arm step
   * carries no request, so this is only set on the deliberate second
   * click; it drives both the disabled state and the loading labels, and
   * clears when the store's action settles (success or error).
   */
  protected readonly inflight = signal<'rate' | 'paid' | 'method' | null>(null);

  /** True while either money action's request is in flight. */
  readonly busy = computed(
    () => this.inflight() !== null || this.actionStatus() === 'submitting',
  );

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
   * Planned payment method. Seeded from the invoice's current method in
   * ngOnInit (inputs are not set during field initialization).
   */
  readonly methodForm = new FormGroup({
    method: new FormControl<BuilderPaymentMethod>('card', {
      validators: [Validators.required],
      nonNullable: true,
    }),
  });

  /**
   * Live selected method. Tracked through `valueChanges` because
   * `FormControl.value` is a plain property read, not a signal.
   */
  private readonly methodValue = toSignal(
    this.methodForm.controls.method.valueChanges.pipe(
      startWith(this.methodForm.controls.method.value),
    ),
    { initialValue: 'card' as BuilderPaymentMethod },
  );

  /** True when the selected method differs from the invoice's. */
  protected readonly methodChanged = computed(
    () => this.methodValue() !== this.invoice().paymentMethod,
  );

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

  /** True when the confirmed result is a mark-paid (it carries paidAt). */
  readonly confirmedPaid = computed(() => {
    const confirmed = this.confirmedInvoice();
    return confirmed !== null && isMarkPaidResponse(confirmed);
  });

  /** True when the confirmed result is a planned-payment-method change. */
  readonly confirmedMethod = computed(() => {
    const confirmed = this.confirmedInvoice();
    return confirmed !== null && isPlannedMethodResponse(confirmed);
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
  readonly confirmedMethodLabel = computed(() => {
    const confirmed = this.confirmedInvoice();
    return confirmed !== null && isPlannedMethodResponse(confirmed)
      ? this.plannedMethodLabel(confirmed.paymentMethod)
      : null;
  });

  ngOnInit(): void {
    this.methodForm.controls.method.setValue(this.invoice().paymentMethod);
  }

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

  plannedMethodLabel(method: BuilderPaymentMethod | ''): string {
    return (
      this.plannedMethodOptions.find((option) => option.value === method)
        ?.label ?? method
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

  /**
   * The deliberate second click: dispatch the rate override.
   * Double-submit guard: a second click before change detection runs is
   * impossible because the confirm UI unmounts on the first click, and
   * `busy()` rejects any re-dispatch until the request settles.
   */
  confirmRateUpdate(): void {
    const rate = this.rateForm.controls.rate.value;
    if (rate === null || rate <= 0 || rate > 10 || this.busy()) return;
    this.confirmingRate.set(false);
    this.inflight.set('rate');
    this.store
      .dispatch(new SetCommissionRate(this.invoice().id, rate))
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.inflight.set(null)),
      )
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

  /** The deliberate second click: record the payment. Same guard as above. */
  confirmMarkPaid(): void {
    const { method, reference, paidDate } = this.payForm.getRawValue();
    if (method === '' || paidDate === '' || this.busy()) return;
    const body: MarkInvoicePaidRequest = {
      paymentMethod: method,
      paidAt: dateOnlyToIsoWithOffset(paidDate),
    };
    const trimmed = reference.trim();
    this.confirmingPaid.set(false);
    this.inflight.set('paid');
    this.store
      .dispatch(
        new MarkInvoicePaid(
          this.invoice().id,
          trimmed.length > 0 ? { ...body, reference: trimmed } : body,
        ),
      )
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.inflight.set(null)),
      )
      .subscribe();
  }

  /** First click: arm the planned-method confirm (validates first). */
  startMethodConfirm(): void {
    this.methodForm.markAllAsTouched();
    if (this.methodForm.invalid) return;
    this.confirmingMethod.set(true);
  }

  backFromMethodConfirm(): void {
    this.confirmingMethod.set(false);
  }

  /**
   * The deliberate second click: change the planned payment method.
   * Same double-submit guard as the other actions.
   */
  confirmMethodUpdate(): void {
    const method = this.methodForm.controls.method.value;
    if (method === this.invoice().paymentMethod || this.busy()) return;
    this.confirmingMethod.set(false);
    this.inflight.set('method');
    this.store
      .dispatch(new SetInvoicePlannedPaymentMethod(this.invoice().id, method))
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.inflight.set(null)),
      )
      .subscribe();
  }

  close(): void {
    this.store.dispatch(new DismissInvoiceFeedback());
    this.closed.emit();
  }
}
