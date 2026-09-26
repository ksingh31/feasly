import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { withNgxsStoragePlugin } from '@ngxs/storage-plugin';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { ChooseProjectType, ClearComparison, GoToStep, ResetWizard, SelectProperty, StorePreviewEstimate, UpdateComparison, UpdateInputs, UpdateRenoInputs } from './wizard.actions';
import { WizardState, type WizardStateModel } from './wizard.state';

/** FE1-001: wizard state transitions + config-seeded input defaults. */
describe('WizardState', () => {
  let store: Store;
  let httpMock: HttpTestingController;

  const fakeProperty = {
    addressKey: 'calgary-1234-14-st-nw',
    address: '1234 14 St NW, Calgary, AB',
    community: 'Capitol Hill',
    lotSqft: 5000,
    zoning: 'R-CG',
    assessedValue: 729000,
    assessmentYear: 2025,
    yearBuilt: 1978,
    dataAsOf: '2025-07-01',
    stale: false,
  } as PropertyRecord;

  function snapshot(): WizardStateModel {
    return store.selectSnapshot<WizardStateModel>((state) => state.wizard);
  }

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideStore([WizardState])],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({ wizard: { sqftDefault: 2200, renoSqftDefault: 800 } });
    await pending;
    store = TestBed.inject(Store);
  });

  it('seeds input defaults from config', () => {
    expect(snapshot().inputs.sqft).toBe(2200);
    expect(snapshot().step).toBe(1);
    expect(snapshot().property).toBeNull();
  });

  it('SelectProperty stores the property; GoToStep moves the indicator', () => {
    store.dispatch(new SelectProperty(fakeProperty));
    store.dispatch(new GoToStep(2));
    const state = snapshot();
    expect(state.property?.addressKey).toBe(fakeProperty.addressKey);
    expect(state.step).toBe(2);
  });

  it('ChooseProjectType records the project type', () => {
    store.dispatch(new ChooseProjectType('new-build'));
    expect(snapshot().projectType).toBe('new-build');
    expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
  });

  it('ChooseProjectType records the renovation project type', () => {
    store.dispatch(new ChooseProjectType('renovation'));
    expect(snapshot().projectType).toBe('renovation');
    expect(store.selectSnapshot(WizardState.projectType)).toBe('renovation');
  });

  it('UpdateInputs merges partial input changes', () => {
    store.dispatch(new UpdateInputs({ sqft: 2600, tier: 'luxury' }));
    const inputs = snapshot().inputs;
    expect(inputs.sqft).toBe(2600);
    expect(inputs.tier).toBe('luxury');
    expect(inputs.garage).toBe('double');
  });

  it('UpdateRenoInputs merges partial reno changes', () => {
    store.dispatch(new UpdateRenoInputs({ renoType: 'basement', renoSqft: 900 }));
    const reno = snapshot().renoInputs;
    expect(reno.renoType).toBe('basement');
    expect(reno.renoSqft).toBe(900);
    expect(reno.tier).toBe('standard');
    expect(reno.underpinning).toBe(false);
  });

  it('UpdateRenoInputs clears underpinning when reno type leaves basement/combined', () => {
    store.dispatch(new UpdateRenoInputs({ renoType: 'basement', underpinning: true }));
    expect(snapshot().renoInputs.underpinning).toBe(true);
    store.dispatch(new UpdateRenoInputs({ renoType: 'extensive' }));
    expect(snapshot().renoInputs.underpinning).toBe(false);
    // Switching between basement and combined keeps the toggle.
    store.dispatch(new UpdateRenoInputs({ renoType: 'basement', underpinning: true }));
    store.dispatch(new UpdateRenoInputs({ renoType: 'combined' }));
    expect(snapshot().renoInputs.underpinning).toBe(true);
  });

  it('UpdateComparison merges partial comparison changes (NBH-04)', () => {
    expect(snapshot().comparison.slugs).toEqual([]);
    expect(snapshot().comparison.sqft).toBe(2200);
    store.dispatch(new UpdateComparison({ slugs: ['beltline', 'cranston'] }));
    expect(snapshot().comparison.slugs).toEqual(['beltline', 'cranston']);
    expect(snapshot().comparison.sqft).toBe(2200);
    store.dispatch(new UpdateComparison({ sqft: 2500, tier: 'premium' }));
    expect(snapshot().comparison.slugs).toEqual(['beltline', 'cranston']);
    expect(snapshot().comparison.sqft).toBe(2500);
    expect(snapshot().comparison.tier).toBe('premium');
  });

  it('ClearComparison resets the picker state (NBH-04)', () => {
    store.dispatch(new UpdateComparison({ slugs: ['beltline'], sqft: 3000, tier: 'luxury' }));
    store.dispatch(new ClearComparison());
    const comparison = snapshot().comparison;
    expect(comparison.slugs).toEqual([]);
    expect(comparison.sqft).toBe(2200);
    expect(comparison.tier).toBe('standard');
  });

  it('ResetWizard restores config defaults', () => {
    store.dispatch(new SelectProperty(fakeProperty));
    store.dispatch(new GoToStep(3));
    store.dispatch(new UpdateRenoInputs({ renoType: 'addition', renoSqft: 400 }));
    store.dispatch(new UpdateComparison({ slugs: ['beltline'], sqft: 3000 }));
    store.dispatch(new ResetWizard());
    const state = snapshot();
    expect(state.property).toBeNull();
    expect(state.step).toBe(1);
    expect(state.inputs.sqft).toBe(2200);
    expect(state.renoInputs.renoType).toBeNull();
    expect(state.renoInputs.renoSqft).toBe(800);
    expect(state.comparison.slugs).toEqual([]);
    expect(state.comparison.sqft).toBe(2200);
  });

  it('preview starts null; StorePreviewEstimate stores it; ResetWizard clears it', () => {
    expect(snapshot().preview).toBeNull();
    const preview = {
      estimateId: 'est-mock-2200-standard',
      addressKey: fakeProperty.addressKey,
      inputs: snapshot().inputs,
      figures: {
        // Real computed figures — the UI renders them blurred pre-gate.
        build: { low: 380000, base: 420000, high: 465000 },
        total: { low: 760000, base: 840000, high: 930000 },
        land: { value: 420000 },
      },
      rows: [],
      costDataVersion: 'mock-v1',
      createdAt: '2026-09-24T00:00:00.000Z',
    } as const;
    store.dispatch(new StorePreviewEstimate(preview));
    expect(snapshot().preview?.estimateId).toBe('est-mock-2200-standard');
    expect(store.selectSnapshot(WizardState.preview)?.estimateId).toBe('est-mock-2200-standard');
    store.dispatch(new ResetWizard());
    expect(snapshot().preview).toBeNull();
  });

  it('selectors expose property, inputs, and step', () => {
    store.dispatch(new SelectProperty(fakeProperty));
    expect(store.selectSnapshot(WizardState.property)?.addressKey).toBe(fakeProperty.addressKey);
    expect(store.selectSnapshot(WizardState.inputs).sqft).toBe(2200);
    expect(store.selectSnapshot(WizardState.step)).toBe(1);
  });

  it('seeds sqft from config for first-time visitors (no stored state)', () => {
    localStorage.clear();
    expect(snapshot().inputs.sqft).toBe(2200);
  });

  it('never clobbers a rehydrated value with the config default', async () => {
    localStorage.setItem(
      'wizard',
      JSON.stringify({
        property: null,
        projectType: 'new-build',
        step: 2,
        inputs: { sqft: 2600, tier: 'luxury', garage: 'double', basement: 'unfinished' },
      }),
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([WizardState], withNgxsStoragePlugin({ keys: [WizardState] })),
      ],
    });
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    TestBed.inject(HttpTestingController)
      .expectOne('/assets/config/app-config.json')
      .flush({ wizard: { sqftDefault: 2200, renoSqftDefault: 800 } });
    await pending;
    const rehydrated = TestBed.inject(Store).selectSnapshot<WizardStateModel>(
      (state) => state.wizard,
    );
    expect(rehydrated.inputs.sqft).toBe(2600);
    expect(rehydrated.inputs.tier).toBe('luxury');
    expect(rehydrated.projectType).toBe('new-build');
    expect(rehydrated.step).toBe(2);
    localStorage.clear();
  });

  it('migrates stale persisted state missing renoInputs/comparison (pre-RENO-03)', async () => {
    // Regression test for the /estimate/reno-scope crash: localStorage written
    // by versions before RENO-03 (PR #83) has no `renoInputs` field, and
    // versions before NBH-04 (PR #106) have no `comparison`. Without migration,
    // the selectors return undefined and the reno-scope template throws
    // (global error handler redirects to /error).
    localStorage.setItem(
      'wizard',
      JSON.stringify({
        property: null,
        projectType: 'renovation',
        step: 2,
        inputs: { sqft: 2100, tier: 'standard', garage: 'double', basement: 'unfinished' },
        // NOTE: no renoInputs, no comparison — simulates pre-RENO-03 data.
      }),
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([WizardState], withNgxsStoragePlugin({ keys: [WizardState] })),
      ],
    });
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    TestBed.inject(HttpTestingController)
      .expectOne('/assets/config/app-config.json')
      .flush({ wizard: { sqftDefault: 2200, renoSqftDefault: 800 } });
    await pending;
    const store = TestBed.inject(Store);
    const rehydrated = store.selectSnapshot<WizardStateModel>((state) => state.wizard);
    // Missing sub-states are backfilled with defaults...
    expect(rehydrated.renoInputs).toBeDefined();
    expect(rehydrated.renoInputs.renoType).toBeNull();
    expect(rehydrated.renoInputs.renoSqft).toBe(800);
    expect(rehydrated.comparison).toBeDefined();
    expect(rehydrated.comparison.slugs).toEqual([]);
    // ...while existing user data is preserved.
    expect(rehydrated.projectType).toBe('renovation');
    expect(rehydrated.step).toBe(2);
    expect(rehydrated.inputs.sqft).toBe(2100);
    // Selectors must not return undefined (the crash trigger).
    expect(store.selectSnapshot(WizardState.renoInputs)).toBeDefined();
    expect(store.selectSnapshot(WizardState.renoInputs).renoType).toBeNull();
    localStorage.clear();
  });
});
