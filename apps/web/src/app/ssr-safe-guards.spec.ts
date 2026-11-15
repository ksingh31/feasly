/**
 * Issue #515 (review B8): the wizard/report guards read localStorage-backed
 * NGXS state. The server has no localStorage, so on the server platform they
 * must always activate — otherwise a reload of `/estimate/*` in dev answers
 * `302 → /`. In the browser the same empty state still redirects to `/`.
 */
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type CanActivateFn, provideRouter, UrlTree } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_SERVICE } from './core/api/api.service';
import { leadGateGuard } from './features/compare/lead-gate.guard';
import { ComparisonState } from './features/compare/comparison.state';
import { reportEstimateGuard } from './features/report/report-estimate.guard';
import { ReportState } from './features/report/report.state';
import { wizardPropertyGuard } from './features/wizard/wizard-property.guard';
import { wizardScopeGuard } from './features/wizard/wizard-scope.guard';
import { WizardState } from './features/wizard/wizard.state';

const guards: ReadonlyArray<[string, CanActivateFn]> = [
  ['wizardPropertyGuard', wizardPropertyGuard],
  ['wizardScopeGuard', wizardScopeGuard],
  ['leadGateGuard', leadGateGuard],
  ['reportEstimateGuard', reportEstimateGuard],
];

function configure(platform: 'server' | 'browser'): void {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      provideRouter([]),
      provideStore([WizardState, ReportState, ComparisonState]),
      // States inject the API; the guards never call it.
      { provide: API_SERVICE, useValue: {} },
    ],
  });
}

function run(guard: CanActivateFn): unknown {
  return TestBed.runInInjectionContext(() => guard({} as never, {} as never));
}

describe('SSR-safe wizard/report guards (#515)', () => {
  describe('server platform', () => {
    beforeEach(() => configure('server'));

    it.each(guards)('%s activates with an empty (non-rehydrated) store', (_name, guard) => {
      expect(run(guard)).toBe(true);
    });
  });

  describe('browser platform', () => {
    beforeEach(() => configure('browser'));

    it.each(guards)('%s still redirects an empty wizard to /', (_name, guard) => {
      const result = run(guard);
      expect(result).toBeInstanceOf(UrlTree);
      expect((result as UrlTree).toString()).toBe('/');
    });
  });
});
