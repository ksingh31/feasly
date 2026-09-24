import { __decorate } from "tslib";
import { inject, Injectable } from '@angular/core';
import { Action, Selector, State } from '@ngxs/store';
import { STORAGE_ENGINE } from '@ngxs/storage-plugin';
import { ConfigService } from '../../core/config/config.service';
import { ChooseProjectType, GoToStep, ResetWizard, SelectProperty, UpdateInputs, } from './wizard.actions';
/** The storage-plugin key for this state (mirrors the @State name). */
const WizardStateName = 'wizard';
/**
 * Wizard state (FE1-001): the single source of truth for the estimate flow.
 * Persisted to localStorage via the NGXS storage plugin — property and
 * inputs only; nothing sensitive is stored pre-gate (no email/name here).
 */
let WizardState = class WizardState {
    config = inject(ConfigService);
    /** Null when the storage plugin isn't registered (unit tests) or on the server. */
    storage = inject(STORAGE_ENGINE, { optional: true });
    /**
     * Seeds the square-footage default from deploy config for first-time
     * visitors. The storage plugin rehydrates persisted state during the
     * InitState action — which runs before this hook — so a stored value
     * always wins: we only seed when nothing was persisted yet.
     */
    ngxsOnInit(ctx) {
        const stored = this.storage?.getItem(WizardStateName);
        if (stored == null) {
            ctx.patchState({
                inputs: { ...ctx.getState().inputs, sqft: this.config.get('wizard').sqftDefault },
            });
        }
    }
    static property(state) {
        return state.property;
    }
    static inputs(state) {
        return state.inputs;
    }
    static step(state) {
        return state.step;
    }
    selectProperty(ctx, action) {
        ctx.patchState({ property: action.property });
    }
    chooseProjectType(ctx, action) {
        ctx.patchState({ projectType: action.projectType });
    }
    updateInputs(ctx, action) {
        ctx.patchState({ inputs: { ...ctx.getState().inputs, ...action.inputs } });
    }
    goToStep(ctx, action) {
        ctx.patchState({ step: action.step });
    }
    resetWizard(ctx) {
        const wizard = this.config.get('wizard');
        ctx.setState({
            property: null,
            projectType: null,
            inputs: {
                sqft: wizard.sqftDefault,
                tier: 'standard',
                garage: 'double',
                basement: 'unfinished',
            },
            step: 1,
        });
    }
};
__decorate([
    Action(SelectProperty)
], WizardState.prototype, "selectProperty", null);
__decorate([
    Action(ChooseProjectType)
], WizardState.prototype, "chooseProjectType", null);
__decorate([
    Action(UpdateInputs)
], WizardState.prototype, "updateInputs", null);
__decorate([
    Action(GoToStep)
], WizardState.prototype, "goToStep", null);
__decorate([
    Action(ResetWizard)
], WizardState.prototype, "resetWizard", null);
__decorate([
    Selector()
], WizardState, "property", null);
__decorate([
    Selector()
], WizardState, "inputs", null);
__decorate([
    Selector()
], WizardState, "step", null);
WizardState = __decorate([
    State({
        name: WizardStateName,
        defaults: {
            property: null,
            projectType: null,
            inputs: {
                sqft: 0,
                tier: 'standard',
                garage: 'double',
                basement: 'unfinished',
            },
            step: 1,
        },
    }),
    Injectable()
], WizardState);
export { WizardState };
