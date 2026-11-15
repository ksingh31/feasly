import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Location } from '@angular/common';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type { AutocompleteSuggestion, PropertyRecord } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api';
import type { ApiService } from '../../core/api';
import { ConfigService } from '../../core/config';
import {
  ChooseProjectType,
  LeadState,
  SelectProperty,
  SetEntrySource,
  StoreLeadResult,
  UpdateInputs,
  WizardState,
} from '../wizard';
import { ReportState } from '../report/report.state';
import { SetReportToken } from '../report/report.actions';
import { LandingPageComponent } from './landing-page.component';

@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * #692: estimator deep link `/?address=<text>&src=<source>`. The landing page
 * reads it in the browser after first render, looks the address up through
 * the normal autocomplete path and continues exactly as a typed pick would.
 */
describe('LandingPageComponent estimator deep link (#692)', () => {
  let fixture: ComponentFixture<LandingPageComponent>;
  let store: Store;
  let router: Router;
  let location: Location;
  let meta: Meta;

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

  const suggestion = (n: number): AutocompleteSuggestion =>
    ({ addressKey: `key-${n}`, address: `${n} 14 St NW, Calgary, AB` }) as AutocompleteSuggestion;

  function stubApi(autocomplete: ApiService['autocomplete']) {
    return {
      autocomplete: vi.fn(autocomplete),
      getProperty: vi.fn().mockReturnValue(of(property)),
      getCityDataFreshness: vi.fn().mockReturnValue(of({ rollYear: null, refreshedMonth: null })),
    };
  }

  async function open(
    url: string,
    api: ReturnType<typeof stubApi>,
    seed?: (store: Store) => void,
  ): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [LandingPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_SERVICE, useValue: api as unknown as ApiService },
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'estimate/scope', component: BlankComponent },
          { path: 'communities/:slug', component: BlankComponent },
        ]),
        provideStore([WizardState, LeadState, ReportState]),
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({
      api: { useMockApi: false },
      propertyData: { source: 'mock' },
      timings: { debounceMs: 1 },
    });
    await pending;
    store = TestBed.inject(Store);
    router = TestBed.inject(Router);
    location = TestBed.inject(Location);
    meta = TestBed.inject(Meta);
    seed?.(store);
    await router.navigateByUrl(url);
    fixture = TestBed.createComponent(LandingPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** Polls for a condition with a deadline (no fixed sleeps). */
  async function waitFor(check: () => boolean, deadlineMs = 2000): Promise<void> {
    const end = Date.now() + deadlineMs;
    while (!check()) {
      if (Date.now() > end) throw new Error('waitFor: condition not met before deadline');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function input(): HTMLInputElement {
    return fixture.nativeElement.querySelector('app-address-autocomplete input') as HTMLInputElement;
  }

  afterEach(() => {
    meta.removeTag('name="robots"');
    document.head
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((el) => el.remove());
  });

  it('a single-match address loads the property and lands on the scope step (AC1)', async () => {
    const api = stubApi(() => of({ suggestions: [suggestion(1234)] }));
    const navigate = vi.spyOn(Router.prototype, 'navigate');
    await open('/?address=1234%2014%20St%20NW', api);
    await waitFor(() => navigate.mock.calls.some((c) => c[0]?.[0] === '/estimate/scope'));

    expect(api.autocomplete).toHaveBeenCalledTimes(1);
    expect(api.autocomplete).toHaveBeenCalledWith('1234 14 St NW');
    expect(api.getProperty).toHaveBeenCalledWith('key-1234');
    expect(store.selectSnapshot(WizardState.property)?.addressKey).toBe(property.addressKey);
    expect(store.selectSnapshot(WizardState.step)).toBe(2);
    navigate.mockRestore();
  });

  it('starts a fresh wizard: stale property, inputs, lead and report are cleared (scope 3)', async () => {
    const api = stubApi(() => of({ suggestions: [suggestion(1), suggestion(2)] }));
    await open('/?address=14%20St%20NW', api, (s) => {
      s.dispatch([
        new SelectProperty({ ...property, addressKey: 'old-key' }),
        new ChooseProjectType('renovation'),
        new UpdateInputs({ sqft: 3999, tier: 'premium' }),
        new StoreLeadResult({ leadId: 'lead-old', email: 'old@example.com', magicLinkSent: true, expiresInDays: 7 }),
        new SetReportToken('token-old'),
      ]);
    });
    expect(store.selectSnapshot(WizardState.property)).toBeNull();
    expect(store.selectSnapshot(WizardState.projectType)).toBeNull();
    expect(store.selectSnapshot(WizardState.inputs).sqft).toBe(TestBed.inject(ConfigService).get('wizard').sqftDefault);
    expect(store.selectSnapshot(LeadState.leadId)).toBeNull();
    expect(store.selectSnapshot(ReportState.reportToken)).toBeNull();
  });

  it('several matches open the existing picker with the query prefilled, no auto-pick (AC2)', async () => {
    const api = stubApi(() => of({ suggestions: [suggestion(1), suggestion(2), suggestion(3)] }));
    await open('/?address=14%20St%20NW', api);
    await waitFor(() => fixture.nativeElement.querySelectorAll('[role="option"]').length === 3);
    expect(input().value).toBe('14 St NW');
    expect(api.getProperty).not.toHaveBeenCalled();
    expect(store.selectSnapshot(WizardState.property)).toBeNull();
    expect(location.path()).toBe('');
  });

  it('no match keeps the address in the box and shows the no-results message (AC2)', async () => {
    const api = stubApi(() => of({ suggestions: [] }));
    await open('/?address=99999%20Nowhere%20Rd%20SW', api);
    fixture.detectChanges();
    const copy = TestBed.inject(ConfigService).get('copy').search;
    await waitFor(() => {
      fixture.detectChanges();
      return fixture.nativeElement.textContent.includes(copy.noResults);
    });
    expect(input().value).toBe('99999 Nowhere Rd SW');
    expect(api.autocomplete).toHaveBeenCalledTimes(1);
  });

  it('out of coverage keeps the address in the box and shows the Calgary-only message (AC2)', async () => {
    const api = stubApi(() =>
      throwError(() => ({ code: 'OUT_OF_COVERAGE', message: 'x', retryable: false })),
    );
    await open('/?address=10%20Jasper%20Ave%20Edmonton', api);
    await waitFor(() => {
      fixture.detectChanges();
      return fixture.nativeElement.querySelector('app-address-autocomplete')?.textContent.includes('Calgary');
    });
    const autocomplete = fixture.debugElement.query((d) => d.name === 'app-address-autocomplete')
      .componentInstance as { outOfCoverage(): boolean };
    expect(autocomplete.outOfCoverage()).toBe(true);
    expect(input().value).toBe('10 Jasper Ave Edmonton');
    expect(api.autocomplete).toHaveBeenCalledTimes(1);
  });

  it('an over-long or malformed address is ignored: plain landing page, no lookup (AC3)', async () => {
    for (const bad of ['1'.repeat(500), '%3Cscript%3Ealert(1)%3C%2Fscript%3E', 'ab']) {
      const api = stubApi(() => of({ suggestions: [suggestion(1)] }));
      const seeded = { ...property, addressKey: 'kept' };
      await open(`/?address=${bad}`, api, (s) => s.dispatch(new SelectProperty(seeded)));
      expect(api.autocomplete).not.toHaveBeenCalled();
      expect(input().value).toBe('');
      // Ignored link: nothing reset either.
      expect(store.selectSnapshot(WizardState.property)?.addressKey).toBe('kept');
      expect(fixture.nativeElement.querySelector('.hero-title')).toBeTruthy();
    }
  });

  it('a parameterized URL is noindex and the canonical drops the parameter (AC4)', async () => {
    const api = stubApi(() => of({ suggestions: [suggestion(1), suggestion(2)] }));
    await open('/?address=14%20St%20NW&src=guide', api);
    expect(meta.getTag('name="robots"')?.content).toBe('noindex,nofollow');
    const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    expect(canonical?.href).toMatch(/\/$/);
    expect(canonical?.href).not.toContain('address');
  });

  it('the plain landing page stays indexable', async () => {
    const api = stubApi(() => of({ suggestions: [] }));
    await open('/', api);
    expect(meta.getTag('name="robots"')).toBeNull();
    expect(api.autocomplete).not.toHaveBeenCalled();
  });

  it('removes only the deep-link parameters from the address bar (Back never re-runs it)', async () => {
    const api = stubApi(() => of({ suggestions: [suggestion(1), suggestion(2)] }));
    await open('/?utm_source=google&address=14%20St%20NW&src=guide', api);
    // Location normalizes the root path to '' (the bar shows `/?utm_source=google`).
    expect(location.path()).toBe('?utm_source=google');
  });

  it('a known src is recorded on the funnel; an unknown one is dropped (AC6)', async () => {
    const api = stubApi(() => of({ suggestions: [suggestion(1), suggestion(2)] }));
    await open('/?address=14%20St%20NW&src=community-lots', api);
    expect(store.selectSnapshot(WizardState.entrySource)).toBe('community-lots');

    await open('/?address=14%20St%20NW&src=evil-campaign', api, (s) =>
      s.dispatch(new SetEntrySource('guide')),
    );
    // Fresh funnel + unknown source: nothing carried over, nothing recorded.
    expect(store.selectSnapshot(WizardState.entrySource)).toBeNull();
  });
});
