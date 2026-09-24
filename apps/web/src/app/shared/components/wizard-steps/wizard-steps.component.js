import { __decorate } from "tslib";
import { Component, inject, input } from '@angular/core';
import { ConfigService } from '../../../core/config';
/**
 * Wizard step indicator (shared): 1 Address → 2 Scope → 3 Details.
 * Labels come from config copy (no-hardcode rule). Scaffolding for the
 * wizard shell — WEB-005/WEB-006 flesh out the steps.
 */
let WizardStepsComponent = class WizardStepsComponent {
    current = input.required();
    copy = inject(ConfigService).get('copy').wizard;
    steps = [
        { n: 1, label: this.copy.stepAddress },
        { n: 2, label: this.copy.stepScope },
        { n: 3, label: this.copy.stepDetails },
    ];
};
WizardStepsComponent = __decorate([
    Component({
        selector: 'app-wizard-steps',
        standalone: true,
        templateUrl: './wizard-steps.component.html',
        styleUrl: './wizard-steps.component.scss',
    })
], WizardStepsComponent);
export { WizardStepsComponent };
