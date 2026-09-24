import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { GoToStep, SelectProperty, WizardState } from '../wizard';
import { wizardScopeGuard } from './wizard-scope.guard';

/** Blank route target for guard assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

/** FE-004: the gate/analyzing guard needs property + scope, else the address step. */
describe('wizardScopeGuard', () => {
  let store: Store;
  let router: Router;
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

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [BlankComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'estimate/gate', component: BlankComponent, canActivate: [wizardScopeGuard] },
        ]),
        provideStore([WizardState]),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({});
    await pending;
    store = TestBed.inject(Store);
    router = TestBed.inject(Router);
  });

  it('redirects an empty wizard to the address step', async () => {
    // navigate() resolves true when the guard redirects — the URL proves it.
    await router.navigate(['/estimate/gate']);
    expect(router.url).toBe('/');
  });

  it('redirects when only the property is set (scope step never reached)', async () => {
    store.dispatch(new SelectProperty(fakeProperty));
    // Landing selects the property with step 1 here to simulate "never
    // visited scope" — the guard needs step >= 2.
    store.dispatch(new GoToStep(1));
    await router.navigate(['/estimate/gate']);
    expect(router.url).toBe('/');
  });

  it('lets the gate render with property + scope step reached', async () => {
    store.dispatch([new SelectProperty(fakeProperty), new GoToStep(2)]);
    const result = await router.navigate(['/estimate/gate']);
    expect(result).toBe(true);
    expect(router.url).toBe('/estimate/gate');
  });
});
