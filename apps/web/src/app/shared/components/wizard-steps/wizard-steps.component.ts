import { Component, inject, input } from '@angular/core';
import { ConfigService } from '../../../core/config';
import type { WizardStep } from '../../../features/wizard';

/**
 * Wizard step indicator (shared): 1 Address → 2 Your home → 3 Estimate.
 * Three honest steps matching the screens (#507): landing = Address, scope /
 * reno-scope = Your home, preview + gate = Estimate. Labels from config copy.
 */
@Component({
  selector: 'app-wizard-steps',
  standalone: true,
  templateUrl: './wizard-steps.component.html',
  styleUrl: './wizard-steps.component.scss',
})
export class WizardStepsComponent {
  readonly current = input.required<WizardStep>();
  private readonly copy = inject(ConfigService).get('copy').wizard;
  protected readonly steps = [
    { n: 1, label: this.copy.stepAddress },
    { n: 2, label: this.copy.stepScope },
    { n: 3, label: this.copy.stepEstimate },
  ];
}
