/** NGXS action: user picked a property (landing autocomplete or S1). */
export class SelectProperty {
    property;
    static type = '[Wizard] Select property';
    constructor(property) {
        this.property = property;
    }
}
/** NGXS action: user chose a project type on the scope step. */
export class ChooseProjectType {
    projectType;
    static type = '[Wizard] Choose project type';
    constructor(projectType) {
        this.projectType = projectType;
    }
}
/** NGXS action: details-step inputs changed. */
export class UpdateInputs {
    inputs;
    static type = '[Wizard] Update inputs';
    constructor(inputs) {
        this.inputs = inputs;
    }
}
/** NGXS action: move the step indicator. */
export class GoToStep {
    step;
    static type = '[Wizard] Go to step';
    constructor(step) {
        this.step = step;
    }
}
/** NGXS action: start over (used by "Estimate another address"). */
export class ResetWizard {
    static type = '[Wizard] Reset';
}
