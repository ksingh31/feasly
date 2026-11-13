import { TestBed } from '@angular/core/testing';
import { UrlTree } from '@angular/router';
import { provideRouter } from '@angular/router';
import { Component } from '@angular/core';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { SelectProperty, UpdateInputs, WizardState } from '../wizard';
import { API_SERVICE } from '../../core/api/api.service';
import { reportEstimateGuard } from './report-estimate.guard';
import { SetReportToken } from './report.actions';
import { ReportState } from './report.state';

@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * M1: the report route needs a completed estimate basis (property + sqft) —
 * deep links without one land on the address step, never an empty report.
 */
describe('reportEstimateGuard', () => {
  const fakeProperty = {
    addressKey: 'calgary-918-16-ave-nw',
    address: '918 16 Ave NW, Calgary, AB',
    community: 'Mount Pleasant',
    lotSqft: 6100,
    zoning: 'R-C1',
    assessedValue: 823000,
    assessmentYear: 2025,
    yearBuilt: 1974,
    dataAsOf: '2025-07-01',
    stale: false,
  } as PropertyRecord;

  let store: Store;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [BlankComponent],
      providers: [
        provideRouter([{ path: '**', component: BlankComponent }]),
        provideStore([WizardState, ReportState]),
        // ReportState injects the API; the guard never calls it.
        { provide: API_SERVICE, useValue: {} },
      ],
    });
    store = TestBed.inject(Store);
  });

  function runGuard(): true | UrlTree {
    return TestBed.runInInjectionContext(() =>
      reportEstimateGuard({} as never, {} as never),
    ) as true | UrlTree;
  }

  it('activates with a property and configured sqft', () => {
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200 })]);
    expect(runGuard()).toBe(true);
  });

  it('redirects to the address step without a property', () => {
    const result = runGuard();
    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/');
  });

  it('redirects when sqft was never configured', () => {
    // ngxsOnInit seeds the compiled sqft default, so zero it explicitly.
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 0 })]);
    const result = runGuard();
    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/');
  });

  // Issue #484: a magic-link / partner-share redemption on a fresh device has
  // no wizard state — the verified report token alone must open the report.
  it('activates with a report token even without wizard state (fresh device)', () => {
    store.dispatch(new SetReportToken('tok-fresh'));
    expect(store.selectSnapshot(WizardState.property)).toBeNull();
    expect(runGuard()).toBe(true);
  });
});
