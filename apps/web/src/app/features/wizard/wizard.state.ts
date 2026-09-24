import { inject, Injectable, Optional } from '@angular/core';
import { Action, NgxsOnInit, Selector, State, StateContext } from '@ngxs/store';
import { STORAGE_ENGINE } from '@ngxs/storage-plugin';
import type { EstimateInputs, PreviewEstimateResponse, PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import {
  ChooseProjectType,
  GoToStep,
  ResetWizard,
  SelectProperty,
  StorePreviewEstimate,
  UpdateInputs,
  type ProjectType,
  type WizardStep,
} from './wizard.actions';

/** The storage-plugin key for this state (mirrors the @State name). */
const WizardStateName = 'wizard';

export interface WizardStateModel {
  /** Selected City property record. Null until the user picks an address. */
  property: PropertyRecord | null;
  /** New build or renovation (RENO-02); null until the user picks on the scope step. */
  projectType: ProjectType | null;
  /** Scope/detail inputs for the estimate request. */
  inputs: EstimateInputs;
  /** Current wizard step (1 address → 2 scope → 3 details). */
  step: WizardStep;
  /**
   * Blurred pre-gate preview from the analyzing screen. Null until the
   * pipeline runs. Carries no PII and no real dollar figures, so persisting
   * it via the storage plugin is safe.
   */
  preview: PreviewEstimateResponse | null;
}

/**
 * Wizard state (FE1-001): the single source of truth for the estimate flow.
 * Persisted to localStorage via the NGXS storage plugin — property, project
 * type, and inputs only; nothing sensitive is stored pre-gate (no email/name here).
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
    preview: null,
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

  @Selector()
  static projectType(state: WizardStateModel): ProjectType | null {
    return state.projectType;
  }

  @Selector()
  static preview(state: WizardStateModel): PreviewEstimateResponse | null {
    return state.preview;
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

  @Action(StorePreviewEstimate)
  storePreviewEstimate(ctx: StateContext<WizardStateModel>, action: StorePreviewEstimate): void {
    ctx.patchState({ preview: action.preview });
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
      preview: null,
    });
  }
}
