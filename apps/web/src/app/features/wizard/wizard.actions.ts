import type { EstimateInputs, PreviewEstimateResponse, PropertyRecord } from '@feasly/contracts';

/** Project types the wizard supports: new builds (M1) and renovations (RENO-02). */
export type ProjectType = 'new-build' | 'renovation';

/** Renovation scope kinds (RENO-01/RENO-03). */
export type RenoType = 'extensive' | 'addition' | 'basement' | 'combined';

/** Wizard steps: 1 address → 2 scope → 3 details. */
export type WizardStep = 1 | 2 | 3;

/** NGXS action: user picked a property (landing autocomplete or S1). */
export class SelectProperty {
  static readonly type = '[Wizard] Select property';
  constructor(public readonly property: PropertyRecord) {}
}

/** NGXS action: user chose a project type on the scope step. */
export class ChooseProjectType {
  static readonly type = '[Wizard] Choose project type';
  constructor(public readonly projectType: ProjectType) {}
}

/** NGXS action: details-step inputs changed. */
export class UpdateInputs {
  static readonly type = '[Wizard] Update inputs';
  constructor(public readonly inputs: Partial<EstimateInputs>) {}
}

/** NGXS action: reno scope-step inputs changed (RENO-03). */
export class UpdateRenoInputs {
  static readonly type = '[Wizard] Update reno inputs';
  constructor(
    public readonly inputs: Partial<{
      renoType: RenoType | null;
      renoSqft: number;
      tier: import('@feasly/contracts').FinishTier;
      underpinning: boolean;
    }>,
  ) {}
}

/** NGXS action: move the step indicator. */
export class GoToStep {
  static readonly type = '[Wizard] Go to step';
  constructor(public readonly step: WizardStep) {}
}

/** NGXS action: start over (used by "Estimate another address"). */
export class ResetWizard {
  static readonly type = '[Wizard] Reset';
}

/**
 * NGXS action: the analyzing screen finished the real estimate pipeline and
 * stored the blurred pre-gate preview. The report page reads it from here —
 * it is persisted by the storage plugin, so a refresh keeps the preview.
 */
export class StorePreviewEstimate {
  static readonly type = '[Wizard] Store preview estimate';
  constructor(public readonly preview: PreviewEstimateResponse) {}
}
