import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Store } from '@ngxs/store';
import { startWith } from 'rxjs';
import { SIMULATED_PAYMENTS_NOTICE } from '@feasly/contracts';
import type { ApiError, SimulatedInvoiceEventKind, SimulatedInvoiceEventRequest } from '@feasly/contracts';
import { UiButtonComponent, UiTextFieldComponent } from '@app/shared/ui';
import { AdminBillingApiService } from './admin-billing-api.service';
import { LoadBillingHealth } from './billing-health.actions';
import { BillingHealthState } from './billing-health.state';

/** Optional partial-refund amount: blank, or a positive whole number of cents. */
const WHOLE_CENTS = /^[1-9]\d*$/;

/** Result of the last fired event, for the status line. */
type PanelResult =
  | { readonly ok: true; readonly eventType: string }
  | { readonly ok: false; readonly message: string };

/**
 * Admin dev panel (#791) for the simulated payment provider (#753).
 *
 * Renders only when GET /api/v1/admin/billing reports
 * `stripe.provider === 'simulated'` (never with the Stripe provider) and the
 * admin holds `billing:manage` (the parent passes `canManage`). Fires
 * a Stripe-shaped event against the invoice's PaymentIntent — Fire
 * dispute, Close dispute: won / lost (#872, closes the open chargeback),
 * Dashboard refund (optional partial `amountCents`) and Delayed failure —
 * through
 * POST /api/v1/admin/billing/simulated/invoices/{id}/events, then shows the
 * delivered `eventType`. A 409 (the action doesn't apply, e.g. an
 * uncharged invoice) shows the API's reason. Emits `fired` so the drawer
 * reloads what the webhook changed.
 */
@Component({
  selector: 'app-admin-simulated-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, UiButtonComponent, UiTextFieldComponent],
  templateUrl: './admin-simulated-panel.component.html',
  styleUrl: './admin-simulated-panel.component.scss',
})
export class AdminSimulatedPanelComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly api = inject(AdminBillingApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly invoiceId = input.required<string>();
  /** `billing:manage` — read-only staff never see the panel. */
  readonly canManage = input(false);
  /** An event was delivered; the parent reloads the invoice. */
  readonly fired = output<string>();

  protected readonly notice = SIMULATED_PAYMENTS_NOTICE;
  private readonly health = this.store.selectSignal(BillingHealthState.health);

  /** Only for the simulated provider, only with `billing:manage`. */
  protected readonly visible = computed(
    () => this.canManage() && this.health()?.stripe.provider === 'simulated',
  );

  protected readonly refundAmount = new FormControl<string>('', { nonNullable: true });
  private readonly refundValue = toSignal(this.refundAmount.valueChanges.pipe(startWith('')), {
    initialValue: '',
  });
  protected readonly refundError = computed(() => {
    const v = this.refundValue().trim();
    return v === '' || WHOLE_CENTS.test(v) ? null : 'Enter whole cents, or leave blank.';
  });

  /** The event in flight, or null. */
  protected readonly busy = signal<SimulatedInvoiceEventKind | null>(null);
  protected readonly result = signal<PanelResult | null>(null);

  ngOnInit(): void {
    // Read-only staff never see the panel: don't touch billing health.
    if (!this.canManage()) return;
    // Opened from /admin/invoices the health payload may not be loaded yet.
    if (this.store.selectSnapshot(BillingHealthState.loadStatus) === 'idle') {
      this.store.dispatch(new LoadBillingHealth());
    }
  }

  protected fire(kind: SimulatedInvoiceEventKind): void {
    if (this.busy() !== null || !this.visible()) return;
    if (kind === 'refund' && this.refundError()) return;
    const amount = kind === 'refund' ? this.refundAmount.value.trim() : '';
    const body: SimulatedInvoiceEventRequest = amount === '' ? { kind } : { kind, amountCents: Number(amount) };
    this.busy.set(kind);
    this.result.set(null);
    this.api
      .fireSimulatedInvoiceEvent(this.invoiceId(), body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.busy.set(null);
          this.result.set({ ok: true, eventType: res.eventType });
          this.fired.emit(res.eventType);
        },
        error: (err: ApiError) => {
          this.busy.set(null);
          this.result.set({ ok: false, message: err?.message || 'The event could not be fired.' });
        },
      });
  }
}
