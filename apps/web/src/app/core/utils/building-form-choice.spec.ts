import { describe, expect, it } from 'vitest';
import type { ZoningDistrictsResponse } from '@feasly/contracts';
import { MOCK_ZONING_DISTRICTS } from '../api/mock-data';
import { buildingFormChoice, findDistrict, requestBuildingForm } from './building-form-choice';

/**
 * #689: the scope step's building-form choice is a presentation mapping of
 * the API's zoning catalogue — district forms + `estimableBuildingForms`.
 * Fixture districts come from the contract-shaped mock catalogue.
 */
describe('buildingFormChoice', () => {
  const cat = MOCK_ZONING_DISTRICTS;

  it('returns null without a catalogue (choice hidden)', () => {
    expect(buildingFormChoice(null, 'R-C1')).toBeNull();
    expect(buildingFormChoice(undefined, 'R-C1')).toBeNull();
  });

  it('covered district: allowed forms, estimable first, with permission', () => {
    const choice = buildingFormChoice(cat, 'R-C2')!;
    expect(choice.status).toBe('covered');
    expect(choice.districtCode).toBe('R-C2');
    expect(choice.sourceUrl).toBe(cat.sourceUrl);
    expect(choice.options[0]).toEqual({ form: 'single-detached', estimable: true, permission: 'permitted' });
    expect(choice.options.filter((o) => !o.estimable).map((o) => o.form)).toEqual([
      'semi-detached',
      'duplex',
      'secondary-suite',
      'backyard-suite',
    ]);
  });

  it('estimable forms come from the API, not from code', () => {
    const more: ZoningDistrictsResponse = { ...cat, estimableBuildingForms: ['single-detached', 'duplex'] };
    const choice = buildingFormChoice(more, 'R-C2')!;
    expect(choice.options.filter((o) => o.estimable).map((o) => o.form)).toEqual([
      'single-detached',
      'duplex',
    ]);
  });

  it.each(['DC', 'ZZ-9', '', null])('fails open for %j: estimable forms only', (zoning) => {
    const choice = buildingFormChoice(cat, zoning)!;
    expect(choice.status).toBe('fail-open');
    expect(choice.options).toEqual([{ form: 'single-detached', estimable: true }]);
  });

  it('matches case-insensitively, through typographic dashes, aliases and modifiers', () => {
    const withAlias: ZoningDistrictsResponse = {
      ...cat,
      districts: cat.districts.map((d) => (d.code === 'R-CG' ? { ...d, aliases: ['RCG'] } : d)),
    };
    expect(findDistrict(cat, ' r–c2 ')?.code).toBe('R-C2');
    expect(findDistrict(withAlias, 'rcg')?.code).toBe('R-CG');
    expect(findDistrict(cat, 'R-CGd75')?.code).toBe('R-CG');
    expect(findDistrict(cat, 'R-CGx')).toBeUndefined();
  });
});

describe('requestBuildingForm', () => {
  const cat = MOCK_ZONING_DISTRICTS;

  it('covered lot: the chosen estimable form, else the first estimable form', () => {
    const choice = buildingFormChoice(cat, 'R-C1');
    expect(requestBuildingForm(choice, undefined)).toBe('single-detached');
    expect(requestBuildingForm(choice, 'single-detached')).toBe('single-detached');
    // A form that is not estimable is never sent.
    expect(requestBuildingForm(choice, 'secondary-suite')).toBe('single-detached');
  });

  it('fail-open lot or no catalogue: no form is sent (legacy request)', () => {
    expect(requestBuildingForm(buildingFormChoice(cat, 'DC'), 'single-detached')).toBeUndefined();
    expect(requestBuildingForm(null, 'single-detached')).toBeUndefined();
  });
});
