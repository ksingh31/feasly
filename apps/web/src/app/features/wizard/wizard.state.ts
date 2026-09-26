import { inject, Injectable, Optional } from '@angular/core';
import { Action, NgxsOnInit, Selector, State, StateContext } from '@ngxs/store';
import { STORAGE_ENGINE } from '@ngxs/storage-plugin';
import type {
  EstimateInputs,
  FinishTier,
  PreviewEstimateResponse,
  PropertyRecord,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import {
  ChooseProjectType,
  GoToStep,
  ResetWizard,
  SelectProperty,
  StorePreviewEstimate,
  UpdateComparison,
  ClearComparison,
  UpdateInputs,
  UpdateRenoInputs,
  type ProjectType,
  type RenoType,
  type WizardStep,
} from './wizard.actions';

/** The storage-plugin key for this state (mirrors the @State name). */
const WizardStateName = 'wizard';

/** Renovation scope inputs (RENO-03). Persisted via the storage plugin. */
export interface RenoInputs {
  /** Renovation kind; null until the user picks on the reno scope step. */
  renoType: RenoType | null;
  /** Affected area in sq ft. */
  renoSqft: number;
  /** Finish tier for the renovation. */
  tier: FinishTier;
  /** Underpinning toggle — only meaningful for basement/combined. */
  underpinning: boolean;
}

/**
 * Neighbourhood comparison picker inputs (NBH-04). Persisted via the storage
 * plugin so a refresh mid-picker restores the selections.
 */
export interface ComparisonInputs {
  /** Selected community slugs (2–3 to continue; max 3 enforced in the UI). */
  slugs: string[];
  /** Build size in sq ft for the comparison. */
  sqft: number;
  /** Finish tier for the comparison. */
  tier: FinishTier;
}

export interface WizardStateModel {
  /** Selected City property record. Null until the user picks an address. */
  property: PropertyRecord | null;
  /** New build or renovation (RENO-02); null until the user picks on the scope step. */
  projectType: ProjectType | null;
  /** Scope/detail inputs for the estimate request. */
  inputs: EstimateInputs;
  /** Renovation scope inputs (RENO-03); used when projectType is 'renovation'. */
  renoInputs: RenoInputs;
  /** Neighbourhood comparison picker inputs (NBH-04). */
  comparison: ComparisonInputs;
  /** Current wizard step (1 address → 2 scope → 3 details). */
  step: WizardStep;
  /**
   * Real-figures pre-gate preview from the analyzing screen (rendered
   * blurred until the lead gate unlocks). Null until the pipeline runs.
   * Carries no PII, so persisting it via the storage plugin is safe.
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
    renoInputs: {
      renoType: null,
      renoSqft: 0,
      tier: 'standard',
      underpinning: false,
    },
    comparison: {
      slugs: [],
      sqft: 0,
      tier: 'standard',
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
   * Seeds the square-footage defaults from deploy config for first-time
   * visitors, and migrates stale persisted state. The storage plugin
   * rehydrates persisted state during the InitState action — which runs
   * before this hook — so a stored value always wins for fields that exist.
   *
   * Migration: `renoInputs` (added RENO-03) and `comparison` (added NBH-04)
   * may be missing from localStorage written by older versions. Without
   * this, selectors return undefined and components crash (global error
   * handler redirects to /error). We backfill missing sub-states with
   * defaults instead of wiping the user's stored property/selections.
   */
  ngxsOnInit(ctx: StateContext<WizardStateModel>): void {
    const wizard = this.config.get('wizard');
    const state = ctx.getState();
    const stored = this.storage?.getItem(WizardStateName);

    // Backfill sub-states that may be missing from stale persisted data.
    // Uses the same defaults as the @State decorator so behavior is
    // identical for first-time visitors and migrated users.
    const renoInputs: RenoInputs = state.renoInputs ?? {
      renoType: null,
      renoSqft: wizard.renoSqftDefault,
      tier: 'standard',
      underpinning: false,
    };
    const comparison: ComparisonInputs = state.comparison ?? {
      slugs: [],
      sqft: wizard.sqftDefault,
      tier: 'standard',
    };

    if (stored == null) {
      // First-time visitor: seed sqft defaults from deploy config.
      ctx.patchState({
        inputs: { ...state.inputs, sqft: wizard.sqftDefault },
        renoInputs: { ...renoInputs, renoSqft: wizard.renoSqftDefault },
        comparison: { ...comparison, sqft: wizard.sqftDefault },
      });
    } else if (state.renoInputs == null || state.comparison == null) {
      // Stale persisted state: backfill missing sub-states, preserving
      // everything the user already had (property, projectType, etc.).
      ctx.patchState({ renoInputs, comparison });
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
  static renoInputs(state: WizardStateModel): RenoInputs {
    return state.renoInputs;
  }

  @Selector()
  static comparison(state: WizardStateModel): ComparisonInputs {
    return state.comparison;
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

  @Action(UpdateRenoInputs)
  updateRenoInputs(ctx: StateContext<WizardStateModel>, action: UpdateRenoInputs): void {
    const current = ctx.getState().renoInputs;
    const next = { ...current, ...action.inputs };
    // Underpinning only applies to basement/combined — clear it when the
    // reno type changes to anything else (RENO-03 AC1).
    if (
      action.inputs.renoType !== undefined &&
      action.inputs.renoType !== 'basement' &&
      action.inputs.renoType !== 'combined'
    ) {
      next.underpinning = false;
    }
    ctx.patchState({ renoInputs: next });
  }

  @Action(GoToStep)
  goToStep(ctx: StateContext<WizardStateModel>, action: GoToStep): void {
    ctx.patchState({ step: action.step });
  }

  @Action(UpdateComparison)
  updateComparison(ctx: StateContext<WizardStateModel>, action: UpdateComparison): void {
    ctx.patchState({
      comparison: { ...ctx.getState().comparison, ...action.inputs },
    });
  }

  @Action(ClearComparison)
  clearComparison(ctx: StateContext<WizardStateModel>): void {
    const wizard = this.config.get('wizard');
    ctx.patchState({
      comparison: { slugs: [], sqft: wizard.sqftDefault, tier: 'standard' },
    });
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
      renoInputs: {
        renoType: null,
        renoSqft: wizard.renoSqftDefault,
        tier: 'standard',
        underpinning: false,
      },
      comparison: {
        slugs: [],
        sqft: wizard.sqftDefault,
        tier: 'standard',
      },
      step: 1,
      preview: null,
    });
  }
}
