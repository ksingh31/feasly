import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { withNgxsStoragePlugin } from '@ngxs/storage-plugin';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import { ChooseProjectType, GoToStep, ResetWizard, SelectProperty, UpdateInputs } from './wizard.actions';
import { WizardState } from './wizard.state';
/** FE1-001: wizard state transitions + config-seeded input defaults. */
describe('WizardState', () => {
    let store;
    let httpMock;
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
    };
    function snapshot() {
        return store.selectSnapshot((state) => state.wizard);
    }
    beforeEach(async () => {
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
            providers: [provideHttpClient(), provideHttpClientTesting(), provideStore([WizardState])],
        });
        httpMock = TestBed.inject(HttpTestingController);
        const config = TestBed.inject(ConfigService);
        const pending = config.load();
        httpMock.expectOne('/assets/config/app-config.json').flush({ wizard: { sqftDefault: 2200 } });
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
    });
    it('UpdateInputs merges partial input changes', () => {
        store.dispatch(new UpdateInputs({ sqft: 2600, tier: 'luxury' }));
        const inputs = snapshot().inputs;
        expect(inputs.sqft).toBe(2600);
        expect(inputs.tier).toBe('luxury');
        expect(inputs.garage).toBe('double');
    });
    it('ResetWizard restores config defaults', () => {
        store.dispatch(new SelectProperty(fakeProperty));
        store.dispatch(new GoToStep(3));
        store.dispatch(new ResetWizard());
        const state = snapshot();
        expect(state.property).toBeNull();
        expect(state.step).toBe(1);
        expect(state.inputs.sqft).toBe(2200);
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
        localStorage.setItem('wizard', JSON.stringify({
            property: null,
            projectType: 'new-build',
            step: 2,
            inputs: { sqft: 2600, tier: 'luxury', garage: 'double', basement: 'unfinished' },
        }));
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
            .flush({ wizard: { sqftDefault: 2200 } });
        await pending;
        const rehydrated = TestBed.inject(Store).selectSnapshot((state) => state.wizard);
        expect(rehydrated.inputs.sqft).toBe(2600);
        expect(rehydrated.inputs.tier).toBe('luxury');
        localStorage.clear();
    });
});
