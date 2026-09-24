import type { EstimateInputs, PropertyRecord } from '@feasly/contracts';

/** Project types the wizard supports. M1: new builds only (FE-2 adds reno). */
export type ProjectType = 'new-build';

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

/** NGXS action: move the step indicator. */
export class GoToStep {
  static readonly type = '[Wizard] Go to step';
  constructor(public readonly step: WizardStep) {}
}

/** NGXS action: start over (used by "Estimate another address"). */
export class ResetWizard {
  static readonly type = '[Wizard] Reset';
}
