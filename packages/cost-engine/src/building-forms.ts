/**
 * Building forms the engine can price (#689).
 *
 * The cost data covers single-detached new builds only. Every other form a
 * district may allow (semi-detached, rowhouse, suites, …) is refused with a
 * typed `UnpricedBuildingFormError` — the engine never invents a figure for
 * a form it has no cost data for. Pricing another form is a cost-data
 * change (owner-supplied rates + a cost_data_version bump), a separate epic.
 *
 * The vocabulary is a plain string here on purpose: the engine has zero
 * dependencies and must not import `@feasly/contracts`. The API maps the
 * contracts `BuildingForm` onto it.
 */
import { EngineInputError } from './types';

/** The form an estimate prices when the request names none. */
export const DEFAULT_BUILDING_FORM = 'single-detached';

/** Forms with cost data. Order is display order. */
export const PRICED_BUILDING_FORMS: readonly string[] = [DEFAULT_BUILDING_FORM];

/** Thrown when an estimate asks for a building form the engine cannot price. */
export class UnpricedBuildingFormError extends EngineInputError {
  readonly buildingForm: string;
  constructor(buildingForm: string) {
    super(`building form not priced yet: ${buildingForm}`);
    this.name = 'UnpricedBuildingFormError';
    this.buildingForm = buildingForm;
  }
}

/** True when the engine has cost data for the form. Omitted = default form. */
export function isPricedBuildingForm(buildingForm: string | undefined): boolean {
  return buildingForm === undefined || PRICED_BUILDING_FORMS.includes(buildingForm);
}
