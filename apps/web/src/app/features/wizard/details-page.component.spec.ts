import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { ChooseProjectType, GoToStep, SelectProperty, UpdateInputs, WizardState } from '../wizard';
import { DetailsPageComponent } from './details-page.component';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * Details step renders a "← Back to scope" link (matching the scope step's
 * "← Back to address" pattern) that routes to /estimate/scope while keeping
 * the wizard state (project type + detail inputs) intact.
 */
describe('DetailsPageComponent', () => {
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<DetailsPageComponent>;
  let store: Store;
  let router: Router;

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

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DetailsPageComponent, BlankComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'estimate/scope', component: BlankComponent },
          { path: 'estimate/details', component: BlankComponent },
          { path: 'estimate/preview', component: BlankComponent },
          { path: 'estimate/reno-scope', component: BlankComponent },
        ]),
        provideStore([WizardState]),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock
      .expectOne('/assets/config/app-config.json')
      .flush({ wizard: { sqftDefault: 2200, sqftMin: 1200, sqftMax: 4000, sqftStep: 50 } });
    await pending;
    store = TestBed.inject(Store);
    router = TestBed.inject(Router);
    store.dispatch(new SelectProperty(fakeProperty));
    store.dispatch(new ChooseProjectType('new-build'));
    store.dispatch(new UpdateInputs({ sqft: 2200, tier: 'standard', garage: 'double', basement: 'unfinished' }));
    fixture = TestBed.createComponent(DetailsPageComponent);
    fixture.detectChanges();
  }

  beforeEach(setup);

  function backLink(): HTMLAnchorElement {
    return fixture.nativeElement.querySelector('a.back');
  }

  it('renders a "← Back to scope" link on the details step', () => {
    const link = backLink();
    expect(link).not.toBeNull();
    expect(link.textContent).toMatch(/back to scope/i);
    expect(link.getAttribute('href')).toBe('/estimate/scope');
  });

  it('navigates back to /estimate/scope without resetting wizard state', async () => {
    backLink().click();
    fixture.detectChanges();
    await pollUrl('/estimate/scope');

    // The (click) handler also moves the wizard step back; state is kept.
    expect(store.selectSnapshot(WizardState.step)).toBe(2);
    expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
    const inputs = store.selectSnapshot(WizardState.inputs);
    expect(inputs.sqft).toBe(2200);
    expect(inputs.tier).toBe('standard');
    expect(store.selectSnapshot(WizardState.property)?.addressKey).toBe('calgary-918-16-ave-nw');
  });

  it('goBack() dispatches GoToStep(2) even without the router', () => {
    store.dispatch(new GoToStep(3));
    fixture.componentInstance.goBack();
    expect(store.selectSnapshot(WizardState.step)).toBe(2);
  });

  it('renders an enabled preview CTA toward /estimate/preview (no next-build note)', () => {
    const cta = fixture.nativeElement.querySelector('a.cta') as HTMLAnchorElement;
    expect(cta).not.toBeNull();
    expect(cta.getAttribute('href')).toBe('/estimate/preview');
    expect(fixture.nativeElement.textContent).not.toMatch(/next build/i);
  });

  it('navigates to /estimate/preview while keeping wizard state', async () => {
    (fixture.nativeElement.querySelector('a.cta') as HTMLAnchorElement).click();
    fixture.detectChanges();
    await pollUrl('/estimate/preview');

    expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
    expect(store.selectSnapshot(WizardState.property)?.addressKey).toBe('calgary-918-16-ave-nw');
  });
});
