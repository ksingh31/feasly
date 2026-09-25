import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { MockApiService } from '../../core/api/mock-api.service';
import { providePropertyData } from '../../core/api/property-data.service';
import { ConfigService } from '../../core/config/config.service';
import { SelectProperty, UpdateComparison, GoToStep, WizardState } from '../wizard';
import { RunComparison } from './comparison.actions';
import { ComparisonState } from './comparison.state';
import { leadGateGuard } from './lead-gate.guard';

/**
 * NBH-03: the single lead gate serves two flows — the wizard flow (property
 * + scope) and the comparison flow (active comparison result, no property).
 * Deep links satisfying neither bounce to landing.
 */
describe('leadGateGuard', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  async function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        providePropertyData(),
        provideStore([WizardState, ComparisonState]),
        { provide: API_SERVICE, useClass: MockApiService },
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock
      .expectOne('/assets/config/app-config.json')
      .flush({
        api: { useMockApi: true },
        timings: { debounceMs: 1, mockLatencyMinMs: 1, mockLatencyMaxMs: 1 },
        propertyData: { source: 'mock' },
      });
    await pending;
    return TestBed.inject(Store);
  }

  function runGuard(): unknown {
    const route = {} as never;
    const state = {} as never;
    return TestBed.runInInjectionContext(() => leadGateGuard(route, state));
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timed out waiting for condition');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const fakeProperty = {
    addressKey: 'calgary-918-16-ave-nw',
    address: '918 16 Ave NW, Calgary, AB',
  } as PropertyRecord;

  it('allows the wizard flow (property + scope step)', async () => {
    const store = await setup();
    store.dispatch(new SelectProperty(fakeProperty));
    store.dispatch(new GoToStep(2));
    expect(runGuard()).toBe(true);
  });

  it('blocks an empty wizard with no comparison result (redirects to landing)', async () => {
    await setup();
    const result = runGuard();
    expect(result).not.toBe(true);
    // It's a UrlTree pointing at /.
    expect(String(result)).toContain('/');
  });

  it('allows the comparison flow with an active result and no property', async () => {
    const store = await setup();
    expect(store.selectSnapshot(WizardState.property)).toBeNull();
    store.dispatch(
      new UpdateComparison({ slugs: ['beltline', 'panorama-hills'], sqft: 2200, tier: 'premium' }),
    );
    store.dispatch(new RunComparison());
    await waitFor(() => store.selectSnapshot(ComparisonState.status) === 'ready');

    expect(store.selectSnapshot(WizardState.property)).toBeNull();
    expect(store.selectSnapshot(ComparisonState.result)).not.toBeNull();
    expect(runGuard()).toBe(true);
  });

  it('still blocks when the comparison pipeline failed', async () => {
    const store = await setup();
    store.dispatch(new UpdateComparison({ slugs: ['beltline', 'no-such-community'] }));
    store.dispatch(new RunComparison());
    await waitFor(() => store.selectSnapshot(ComparisonState.status) === 'error');

    expect(store.selectSnapshot(ComparisonState.result)).toBeNull();
    expect(runGuard()).not.toBe(true);
  });

  it('router is available for the redirect UrlTree', async () => {
    await setup();
    expect(TestBed.inject(Router)).toBeTruthy();
  });
});
