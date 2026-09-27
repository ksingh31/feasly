import { Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { GoToStep } from '../../../features/wizard/wizard.actions';
import type { WizardStep } from '../../../features/wizard/wizard.actions';

/**
 * Wizard back bar (shared, FE-10): the single consistent back control for
 * every wizard step. Rendered as the first element inside `<main>`, above the
 * step indicator and heading — same position, same styling everywhere.
 *
 * Inputs: `label` (config-owned per page), `link` (routerLink target),
 * `step` (optional — dispatches GoToStep(step) before navigation, preserving
 * the old per-page goBack() behavior; the routerLink performs navigation).
 * Stronger visual weight than the old plain-text link: pill with border,
 * hover/focus states, >=44px touch target.
 */
@Component({
  selector: 'app-wizard-back',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './wizard-back.component.html',
  styleUrl: './wizard-back.component.scss',
})
export class WizardBackComponent {
  private readonly store = inject(Store);

  readonly label = input.required<string>();
  readonly link = input.required<string | string[]>();
  readonly step = input<WizardStep | null>(null);

  protected onBack(): void {
    const step = this.step();
    if (step !== null) {
      this.store.dispatch(new GoToStep(step));
    }
    // The routerLink on the anchor performs the navigation.
  }
}
