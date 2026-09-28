import {
  Component,
  DestroyRef,
  EventEmitter,
  OnDestroy,
  OnInit,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import type {
  Builder,
  ManualInvoiceRequest,
  ManualInvoiceResponse,
} from '@feasly/contracts';
import { formatCentsToCad } from '../../shared/utils/money';
import { AdminBuildersState } from './admin-builders.state';
import { LoadBuilders } from './admin-builders.actions';
import { BillingHealthState } from './billing-health.state';
import {
  CreateManualInvoice,
  DismissCreateInvoiceFeedback,
} from './billing-health.actions';

/** UUID shape check; the server re-validates strictly. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Display-only commission-rate estimate shown on the review step. The
 * billing page header already presents the model as "Commission · 1%",
 * and the server computes the authoritative figure — this constant never
 * reaches billing math (the create-invoice response carries it).
 */
const DISPLAY_COMMISSION_RATE = 0.01;

/**
 * Formats a local Date as ISO 8601 WITH an explicit timezone offset
 * (e.g. `2026-09-20T12:00:00-06:00`), mirroring the builder
 * report-contract contract shape.
 */
export function toIsoWithOffset(date: Date): string {
  const pad = (n: number): string => String(Math.abs(n)).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * Manual commission-invoice creation form for /admin/billing.
 *
 * Two deliberate clicks for a money action (BILL-03 pattern): fill the
 * form → "Review invoice" shows the calculated 1% figure and the 7-day
 * review-window note → "Confirm create invoice" dispatches.
 *
 * The body mirrors the builder report-contract shape exactly
 * (ManualInvoiceRequest): leadId (required UUID), contractValueCents
 * (integer cents, EXCLUDING land), contractSignedAt (ISO with offset) —
 * plus the admin-picked tenantKey. Dollars entered in the form are
 * converted to cents explicitly before POSTing.
 */
@Component({
  selector: 'app-admin-create-invoice',
  standalone: true,
  imports: [ReactiveFormsModule, DatePipe],
  templateUrl: './admin-create-invoice.component.html',
  styleUrl: './admin-create-invoice.component.scss',
})
export class AdminCreateInvoiceComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  @Output() readonly closed = new EventEmitter<void>();

  readonly builders = this.store.selectSignal(AdminBuildersState.builders);
  readonly listStatus = this.store.selectSignal(AdminBuildersState.listStatus);
  readonly createStatus = this.store.selectSignal(
    BillingHealthState.createStatus,
  );
  readonly createFeedback = this.store.selectSignal(
    BillingHealthState.createFeedback,
  );

  /** Review/confirm step for the money action. */
  readonly reviewing = signal(false);
  /** Confirmation shown once the created invoice arrives. */
  readonly confirmedInvoice = computed<ManualInvoiceResponse | null>(
    () => this.createFeedback()?.invoice ?? null,
  );

  /** Contracts can't be reported as signed in the future. */
  readonly maxSignedDate = new Date().toISOString().slice(0, 10);

  readonly form = new FormGroup({
    builder: new FormControl<string>('', {
      validators: [Validators.required],
      nonNullable: true,
    }),
    leadId: new FormControl<string>('', {
      validators: [Validators.required, Validators.pattern(UUID_PATTERN)],
      nonNullable: true,
    }),
    contractDollars: new FormControl<number | null>(null, {
      validators: [Validators.required, Validators.min(0.01)],
    }),
    signedDate: new FormControl<string>('', {
      validators: [Validators.required],
      nonNullable: true,
    }),
  });

  /** Integer cents EXCLUDING land — explicit dollars → cents conversion. */
  readonly contractValueCents = computed(() => {
    const dollars = this.form.controls.contractDollars.value;
    return dollars === null ? null : Math.round(dollars * 100);
  });

  /** Display-only 1% estimate for the review step. */
  readonly estimatedCommissionCents = computed(() => {
    const cents = this.contractValueCents();
    return cents === null ? null : Math.round(cents * DISPLAY_COMMISSION_RATE);
  });

  ngOnInit(): void {
    if (this.listStatus() === 'idle') {
      this.store.dispatch(new LoadBuilders());
    }
  }

  ngOnDestroy(): void {
    this.store.dispatch(new DismissCreateInvoiceFeedback());
  }

  builderLabel(builder: Builder): string {
    const name = builder.displayName || builder.tenantKey;
    return name === builder.tenantKey
      ? builder.tenantKey
      : `${name} (${builder.tenantKey})`;
  }

  formatCad(cents: number): string {
    return formatCentsToCad(cents);
  }

  startReview(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.reviewing.set(true);
  }

  backToForm(): void {
    this.reviewing.set(false);
  }

  /** The deliberate second click: dispatch the create-invoice action. */
  confirmCreate(): void {
    const cents = this.contractValueCents();
    if (cents === null || cents <= 0) return;
    const [year, month, day] = this.form.controls.signedDate.value
      .split('-')
      .map(Number);
    // Local noon: day-accurate without midnight DST-boundary shifts.
    const signedAt = new Date(year, month - 1, day, 12, 0, 0);
    const body: ManualInvoiceRequest = {
      tenantKey: this.form.controls.builder.value,
      leadId: this.form.controls.leadId.value.trim(),
      contractValueCents: cents,
      contractSignedAt: toIsoWithOffset(signedAt),
    };
    this.store
      .dispatch(new CreateManualInvoice(body))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  close(): void {
    this.store.dispatch(new DismissCreateInvoiceFeedback());
    this.closed.emit();
  }
}
