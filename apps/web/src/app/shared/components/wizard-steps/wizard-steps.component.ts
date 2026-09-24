import { Component, inject, input } from '@angular/core';
import { ConfigService } from '../../../core/config';
import type { WizardStep } from '../../../features/wizard';

/**
 * Wizard step indicator (shared): 1 Address → 2 Scope → 3 Details.
 * Labels come from config copy (no-hardcode rule). Scaffolding for the
 * wizard shell — WEB-005/WEB-006 flesh out the steps.
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
    { n: 3, label: this.copy.stepDetails },
  ];
}
