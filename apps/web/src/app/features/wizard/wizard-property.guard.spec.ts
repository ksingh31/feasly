import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { SelectProperty } from './wizard.actions';
import { WizardState } from './wizard.state';
import { wizardPropertyGuard } from './wizard-property.guard';

/** Blank route target for guard assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * FE-2: the scope step never renders without a selected property — deep
 * links bounce back to the address step instead of a dead end.
 */
describe('wizardPropertyGuard', () => {
  let router: Router;
  let store: Store;

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

  /** Polls the router URL until it settles — never a fixed sleep. */
  async function pollUrl(expected: string): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (router.url === expected) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${expected}; still at ${router.url}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [BlankComponent],
      providers: [
        provideHttpClient(),
        provideRouter([
          { path: '', component: BlankComponent },
          {
            path: 'estimate/scope',
            component: BlankComponent,
            canActivate: [wizardPropertyGuard],
          },
        ]),
        provideStore([WizardState]),
      ],
    });
    router = TestBed.inject(Router);
    store = TestBed.inject(Store);
  });

  it('redirects a deep link to the address step when no property is selected', async () => {
    expect(store.selectSnapshot(WizardState.property)).toBeNull();
    await router.navigate(['/estimate/scope']);
    await pollUrl('/');
    expect(router.url).toBe('/');
  });

  it('lets the scope step render when a property is selected', async () => {
    store.dispatch(new SelectProperty(fakeProperty));
    await router.navigate(['/estimate/scope']);
    await pollUrl('/estimate/scope');
    expect(router.url).toBe('/estimate/scope');
  });
});
