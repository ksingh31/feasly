import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { SelectProperty, WizardState } from '../wizard';
import { ScopePageComponent } from './scope-page.component';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * FE-2: scope step renders config-driven slider + tier cards, writes both
 * into the wizard store, and navigates (CTA → details, back → address).
 */
describe('ScopePageComponent', () => {
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<ScopePageComponent>;
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
      imports: [ScopePageComponent, BlankComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'estimate/scope', component: BlankComponent },
          { path: 'estimate/details', component: BlankComponent },
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
    fixture = TestBed.createComponent(ScopePageComponent);
    fixture.detectChanges();
  }

  beforeEach(setup);

  function slider(): HTMLInputElement {
    return fixture.nativeElement.querySelector('input.sqft-slider');
  }

  function tierButton(id: string): HTMLButtonElement {
    return fixture.nativeElement.querySelector(`.tier-card[data-tier="${id}"]`);
  }

  it('renders the slider with config bounds and the seeded default', () => {
    expect(slider().min).toBe('1200');
    expect(slider().max).toBe('4000');
    expect(slider().step).toBe('50');
    expect(slider().value).toBe('2200');
    expect(fixture.nativeElement.textContent).toContain('2,200');
  });

  it('selects the Standard tier by default', () => {
    const standard = tierButton('standard');
    expect(standard.classList.contains('selected')).toBe(true);
    expect(standard.getAttribute('aria-checked')).toBe('true');
    expect(store.selectSnapshot(WizardState.inputs).tier).toBe('standard');
  });

  it('slider input writes the value into the store, clamped to the range', () => {
    slider().value = '99999';
    slider().dispatchEvent(new Event('input'));
    expect(store.selectSnapshot(WizardState.inputs).sqft).toBe(4000);

    slider().value = '10';
    slider().dispatchEvent(new Event('input'));
    expect(store.selectSnapshot(WizardState.inputs).sqft).toBe(1200);

    slider().value = '2750';
    slider().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(store.selectSnapshot(WizardState.inputs).sqft).toBe(2750);
    expect(fixture.nativeElement.textContent).toContain('2,750');
  });

  it('tier selection updates the store and the selected card', () => {
    tierButton('premium').click();
    fixture.detectChanges();
    expect(store.selectSnapshot(WizardState.inputs).tier).toBe('premium');
    expect(tierButton('premium').getAttribute('aria-checked')).toBe('true');
    expect(tierButton('standard').getAttribute('aria-checked')).toBe('false');
  });

  it('See My Preview implies new-build and routes to the details step', async () => {
    const cta = fixture.nativeElement.querySelector('button.cta') as HTMLButtonElement;
    expect(cta.disabled).toBe(false);
    cta.click();
    await pollUrl('/estimate/details');
    const state = store.selectSnapshot(WizardState.inputs);
    expect(state.tier).toBe('standard');
    expect(store.selectSnapshot((s) => s.wizard.projectType)).toBe('new-build');
    expect(store.selectSnapshot((s) => s.wizard.step)).toBe(3);
  });

  it('back link returns to the address step', async () => {
    await router.navigate(['/estimate/scope']);
    const back = fixture.nativeElement.querySelector('a.back') as HTMLAnchorElement;
    back.click();
    await pollUrl('/');
    expect(store.selectSnapshot((s) => s.wizard.step)).toBe(1);
  });
});
