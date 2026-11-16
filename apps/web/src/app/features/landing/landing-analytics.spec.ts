import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { PropertyRecord } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api';
import type { ApiService } from '../../core/api';
import { ConfigService } from '../../core/config';
import { LeadState, WizardState } from '../wizard';
import { ReportState } from '../report/report.state';
import { AnalyticsService } from '../consent/analytics.service';
import { LandingPageComponent } from './landing-page.component';

@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * #815: landing funnel analytics. Each address lookup reports once
 * (address_search, plus address_no_results / out_of_coverage), a pick fires
 * address_selected, and an unpriceable pick fires property_unsupported.
 * Consent gating lives inside AnalyticsService (mocked here).
 */
describe('LandingPageComponent funnel analytics (#815)', () => {
  let fixture: ComponentFixture<LandingPageComponent>;
  let store: Store;
  let track: ReturnType<typeof vi.fn>;

  const property = {
    addressKey: 'calgary-1234-14-st-nw',
    address: '1234 14 St NW, Calgary, AB',
    community: 'Capitol Hill',
    lotSqft: 5000,
    zoning: 'R-C1',
    assessedValue: 729000,
    assessmentYear: 2025,
    yearBuilt: 1978,
    dataAsOf: '2025-07-01',
    stale: false,
  } as PropertyRecord;

  async function open(seed?: (store: Store) => void): Promise<void> {
    TestBed.resetTestingModule();
    track = vi.fn();
    const api = {
      autocomplete: vi.fn().mockReturnValue(of([])),
      getCityDataFreshness: vi.fn().mockReturnValue(of({ rollYear: null, refreshedMonth: null })),
    };
    TestBed.configureTestingModule({
      imports: [LandingPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_SERVICE, useValue: api as unknown as ApiService },
        { provide: AnalyticsService, useValue: { track } },
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'my-report', component: BlankComponent },
          { path: 'estimate/scope', component: BlankComponent },
          { path: 'estimate/preview', component: BlankComponent },
          { path: 'estimate/report', component: BlankComponent },
        ]),
        provideStore([WizardState, LeadState, ReportState]),
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush({
      api: { useMockApi: false },
      propertyData: { source: 'mock' },
    });
    await pending;
    store = TestBed.inject(Store);
    seed?.(store);
    fixture = TestBed.createComponent(LandingPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function component(): LandingPageComponent {
    return fixture.componentInstance;
  }

  it('a search with results fires address_search once', async () => {
    await open();
    component().onSearchOutcome('results');
    expect(track.mock.calls).toEqual([['address_search']]);
  });

  it('a search with no results fires address_search + address_no_results', async () => {
    await open();
    component().onSearchOutcome('no_results');
    expect(track.mock.calls).toEqual([['address_search'], ['address_no_results']]);
  });

  it('an out-of-coverage search fires address_search + out_of_coverage', async () => {
    await open();
    component().onSearchOutcome('out_of_coverage');
    expect(track.mock.calls).toEqual([['address_search'], ['out_of_coverage']]);
  });

  it('a failed request fires nothing', async () => {
    await open();
    component().onSearchOutcome('error');
    expect(track).not.toHaveBeenCalled();
  });

  it('a priceable pick fires address_selected only', async () => {
    await open();
    component().onSelected(property);
    expect(track.mock.calls).toEqual([['address_selected']]);
    expect(store.selectSnapshot(WizardState.property)?.addressKey).toBe(property.addressKey);
  });

  it('an unpriceable pick fires address_selected + property_unsupported', async () => {
    await open();
    component().onSelected({ ...property, community: 'Not A Real Community', isNonResidential: true });
    expect(track.mock.calls).toEqual([['address_selected'], ['property_unsupported']]);
  });
});
