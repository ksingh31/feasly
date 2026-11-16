/**
 * #689: building-form guard. Omitted / single-detached price exactly as
 * before; every other form is a typed refusal and never a figure.
 */
import { describe, expect, it } from 'vitest';
import { createEstimate } from '../src/engine';
import { PLACEHOLDER_COST_DATA } from '../src/cost-data';
import {
  DEFAULT_BUILDING_FORM,
  PRICED_BUILDING_FORMS,
  UnpricedBuildingFormError,
  isPricedBuildingForm,
} from '../src/building-forms';
import { EngineInputError, type EngineInput } from '../src/types';

function input(buildingForm?: string): EngineInput {
  return {
    property: { assessedLandValue: 300_000, lotSizeSqft: 2_000, zoning: 'R-C1' },
    scope:
      buildingForm === undefined
        ? { buildSqft: 1_800, tier: 'standard' }
        : { buildSqft: 1_800, tier: 'standard', buildingForm },
  };
}

describe('building forms (#689)', () => {
  it('prices single-detached only', () => {
    expect(PRICED_BUILDING_FORMS).toEqual([DEFAULT_BUILDING_FORM]);
    expect(DEFAULT_BUILDING_FORM).toBe('single-detached');
    expect(isPricedBuildingForm(undefined)).toBe(true);
    expect(isPricedBuildingForm('single-detached')).toBe(true);
    expect(isPricedBuildingForm('semi-detached')).toBe(false);
  });

  it('an omitted form and an explicit single-detached give byte-identical output', () => {
    const omitted = createEstimate(input(), PLACEHOLDER_COST_DATA);
    const explicit = createEstimate(input('single-detached'), PLACEHOLDER_COST_DATA);
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(omitted));
  });

  it.each(['semi-detached', 'duplex', 'rowhouse', 'backyard-suite', 'nonsense'])(
    'refuses %s with a typed error, never a figure',
    (form) => {
      let caught: unknown;
      try {
        createEstimate(input(form), PLACEHOLDER_COST_DATA);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnpricedBuildingFormError);
      expect(caught).toBeInstanceOf(EngineInputError);
      expect((caught as UnpricedBuildingFormError).buildingForm).toBe(form);
      expect((caught as Error).message).not.toMatch(/\d/);
    },
  );
});
