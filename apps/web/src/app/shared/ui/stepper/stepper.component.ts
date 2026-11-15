import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { StatusTone } from '../status/status-dictionary';
import { type StepState, type StepperModel, stepStates } from './stepper';

interface StepRow {
  readonly key: string;
  readonly label: string;
  readonly state: StepState;
}

/**
 * Stepper (portal-ui-kit §3): a horizontal progress track for a lead or an
 * invoice. Feed it `leadStepperModel(status)` / `invoiceStepperModel(status)`
 * or any custom `StepperModel`. The current step carries
 * `aria-current="step"`; each step's state is also spoken.
 */
@Component({
  selector: 'ui-stepper',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './stepper.component.html',
  styleUrl: './stepper.component.scss',
})
export class StepperComponent {
  readonly model = input.required<StepperModel>();
  /** Accessible name, e.g. "Lead progress". */
  readonly label = input('Progress');
  readonly completeLabel = input('Completed');
  readonly currentStateLabel = input('Current');
  readonly upcomingLabel = input('Upcoming');

  protected readonly tone = computed<StatusTone>(() => this.model().tone);

  protected readonly rows = computed<StepRow[]>(() => {
    const { steps, current, currentLabel } = this.model();
    const states = stepStates(steps, current);
    return steps.map((step, i) => ({
      key: step.key,
      state: states[i],
      label: states[i] === 'current' && currentLabel ? currentLabel : step.label,
    }));
  });

  protected stateText(state: StepState): string {
    if (state === 'complete') {
      return this.completeLabel();
    }
    return state === 'current' ? this.currentStateLabel() : this.upcomingLabel();
  }
}
