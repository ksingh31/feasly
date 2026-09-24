import { inject, Injectable, Optional } from '@angular/core';
import { Action, NgxsOnInit, Selector, State, StateContext } from '@ngxs/store';
import { STORAGE_ENGINE } from '@ngxs/storage-plugin';
import type { EstimateInputs, PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import {
  ChooseProjectType,
  GoToStep,
  ResetWizard,
  SelectProperty,
  UpdateInputs,
  type ProjectType,
  type WizardStep,
} from './wizard.actions';

/** The storage-plugin key for this state (mirrors the @State name). */
const WizardStateName = 'wizard';

export interface WizardStateModel {
  /** Selected City property record. Null until the user picks an address. */
  property: PropertyRecord | null;
  /** M1 supports new builds only; reno arrives in FE-2. */
  projectType: ProjectType | null;
  /** Scope/detail inputs for the estimate request. */
  inputs: EstimateInputs;
  /** Current wizard step (1 address → 2 scope → 3 details). */
  step: WizardStep;
}

/**
 * Wizard state (FE1-001): the single source of truth for the estimate flow.
 * Persisted to localStorage via the NGXS storage plugin — property and
 * inputs only; nothing sensitive is stored pre-gate (no email/name here).
 */
@State<WizardStateModel>({
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
})
@Injectable()
export class WizardState implements NgxsOnInit {
  private readonly config = inject(ConfigService);
  /** Null when the storage plugin isn't registered (unit tests) or on the server. */
  private readonly storage = inject(STORAGE_ENGINE, { optional: true });

  /**
   * Seeds the square-footage default from deploy config for first-time
   * visitors. The storage plugin rehydrates persisted state during the
   * InitState action — which runs before this hook — so a stored value
   * always wins: we only seed when nothing was persisted yet.
   */
  ngxsOnInit(ctx: StateContext<WizardStateModel>): void {
    const stored = this.storage?.getItem(WizardStateName);
    if (stored == null) {
      ctx.patchState({
        inputs: { ...ctx.getState().inputs, sqft: this.config.get('wizard').sqftDefault },
      });
    }
  }

  @Selector()
  static property(state: WizardStateModel): PropertyRecord | null {
    return state.property;
  }

  @Selector()
  static inputs(state: WizardStateModel): EstimateInputs {
    return state.inputs;
  }

  @Selector()
  static step(state: WizardStateModel): WizardStep {
    return state.step;
  }

  @Action(SelectProperty)
  selectProperty(ctx: StateContext<WizardStateModel>, action: SelectProperty): void {
    ctx.patchState({ property: action.property });
  }

  @Action(ChooseProjectType)
  chooseProjectType(ctx: StateContext<WizardStateModel>, action: ChooseProjectType): void {
    ctx.patchState({ projectType: action.projectType });
  }

  @Action(UpdateInputs)
  updateInputs(ctx: StateContext<WizardStateModel>, action: UpdateInputs): void {
    ctx.patchState({ inputs: { ...ctx.getState().inputs, ...action.inputs } });
  }

  @Action(GoToStep)
  goToStep(ctx: StateContext<WizardStateModel>, action: GoToStep): void {
    ctx.patchState({ step: action.step });
  }

  @Action(ResetWizard)
  resetWizard(ctx: StateContext<WizardStateModel>): void {
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
}
