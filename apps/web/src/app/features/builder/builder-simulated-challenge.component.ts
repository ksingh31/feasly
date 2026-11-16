import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SIMULATED_PAYMENTS_NOTICE } from '@feasly/contracts';
import type { SimulatedAuthenticateRequest, SimulatedIntentResponse } from '@feasly/contracts';
import { UiButtonComponent } from '@app/shared/ui';
import { BuilderBillingApiService } from './builder-billing-api.service';
import { BUILDER_COPY } from './builder-copy';

/**
 * Dev-only "Complete 3DS challenge" step (#791) for the simulated payment
 * provider (#753). Stands in for the bank's 3D Secure page: Complete or
 * Fail calls POST /api/v1/billing/simulated/authenticate for the intent
 * (`seti_…` from the card modal, `pi_…` from an invoice waiting on 3DS)
 * and emits the API's answer. The parent decides what the outcome means;
 * this component never marks anything paid.
 *
 * Rendered only after the API said `provider: 'simulated'` — never with
 * the Stripe provider.
 */
@Component({
  selector: 'app-builder-simulated-challenge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButtonComponent],
  templateUrl: './builder-simulated-challenge.component.html',
  styleUrl: './builder-simulated-challenge.component.scss',
})
export class BuilderSimulatedChallengeComponent {
  private readonly api = inject(BuilderBillingApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly t = inject(BUILDER_COPY).simulated;
  protected readonly notice = SIMULATED_PAYMENTS_NOTICE;

  /** The SetupIntent / PaymentIntent waiting on 3DS (`requires_action`). */
  readonly intentId = input.required<string>();
  /** Unique heading id when more than one step could be on screen. */
  readonly headingId = input('sim-challenge-heading');
  /** The authenticate call answered; the parent reads the intent status. */
  readonly resolved = output<SimulatedIntentResponse>();

  /** Which button is in flight, or null. */
  protected readonly busy = signal<SimulatedAuthenticateRequest['outcome'] | null>(null);
  protected readonly error = signal(false);

  protected authenticate(outcome: SimulatedAuthenticateRequest['outcome']): void {
    if (this.busy() !== null) return;
    this.busy.set(outcome);
    this.error.set(false);
    this.api
      .simulatedAuthenticate({ intentId: this.intentId(), outcome })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.busy.set(null);
          this.resolved.emit(result);
        },
        error: () => {
          this.busy.set(null);
          this.error.set(true);
        },
      });
  }
}
