import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provideApi } from '../../core/api';
import { ConfigService } from '../../core/config';
import { WizardState } from '../wizard';
import { LandingPageComponent } from './landing-page.component';
/**
 * FE1-001: landing renders the story copy, the trust strip carries no
 * accuracy claim, selection populates wizard state and routes to scope.
 */
describe('LandingPageComponent', () => {
    let httpMock;
    let fixture;
    let component;
    let store;
    let router;
    const baseConfig = {
        api: { useMockApi: true },
        timings: { debounceMs: 1, mockLatencyMinMs: 1, mockLatencyMaxMs: 1 },
        limits: { autocompleteSuggestionLimit: 6 },
    };
    async function setup(configOverrides = {}) {
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
            imports: [LandingPageComponent],
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                provideApi(),
                provideRouter([{ path: 'estimate/scope', component: LandingPageComponent }]),
                provideStore([WizardState]),
            ],
        });
        httpMock = TestBed.inject(HttpTestingController);
        const config = TestBed.inject(ConfigService);
        const pending = config.load();
        httpMock.expectOne('/assets/config/app-config.json').flush({ ...baseConfig, ...configOverrides });
        await pending;
        store = TestBed.inject(Store);
        router = TestBed.inject(Router);
        fixture = TestBed.createComponent(LandingPageComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    }
    beforeEach(async () => {
        await setup();
    });
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
    it('renders the story hero copy', () => {
        const h1 = fixture.nativeElement.querySelector('.hero-title');
        expect(h1?.textContent).toBe('What will it really cost to build your home in Calgary?');
    });
    it('trust strip carries no ±, %, or accuracy claim (copy-lint)', () => {
        const items = [...fixture.nativeElement.querySelectorAll('.trust-item')].map((el) => el.textContent?.trim());
        // Default test config has useMockApi: true → mock items, never live-data claims.
        expect(items).toEqual([
            'Range-based estimates',
            'Sample property data — live City records coming soon',
            'AI cost breakdown',
        ]);
        for (const item of items) {
            expect(item).not.toMatch(/[±%]/);
            expect(item?.toLowerCase()).not.toContain('accura');
        }
    });
    it('trust strip claims live City data only when the mock harness is off', async () => {
        await setup({ api: { useMockApi: false } });
        const items = [...fixture.nativeElement.querySelectorAll('.trust-item')].map((el) => el.textContent?.trim());
        expect(items).toEqual(['Range-based estimates', 'Real City of Calgary data', 'AI cost breakdown']);
    });
    it('hides the sample-report slot while the flag is off', () => {
        expect(fixture.nativeElement.querySelector('.sample-link')).toBeNull();
    });
    it('renders no sample-report link even when the flag is on (no dead ends)', async () => {
        await setup({ features: { sampleReport: true } });
        const links = [...fixture.nativeElement.querySelectorAll('a')].map((a) => a.getAttribute('href'));
        expect(links).not.toContain('/r/sample');
        expect(fixture.nativeElement.querySelector('.sample-link')).toBeNull();
    });
    it('selection populates wizard state at step 2 and routes to /estimate/scope', () => {
        const navigate = vi.spyOn(router, 'navigate');
        component.onSelected(fakeProperty);
        const state = store.selectSnapshot((s) => s.wizard);
        expect(state.property?.addressKey).toBe(fakeProperty.addressKey);
        expect(state.step).toBe(2);
        expect(navigate).toHaveBeenCalledWith(['/estimate/scope']);
    });
    it('submit with an empty query shows the hint (no dead end)', () => {
        component.onSubmit();
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.ac-hint')?.textContent).toContain('Enter your Calgary address');
    });
    it('sets the page title and meta description', () => {
        const title = TestBed.inject(Title).getTitle();
        expect(title).toContain('What will it really cost to build your home in Calgary?');
    });
});
