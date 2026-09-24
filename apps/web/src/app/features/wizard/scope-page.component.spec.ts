import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { ChooseProjectType, GoToStep, SelectProperty, WizardState } from '../wizard';
import { ScopePageComponent } from './scope-page.component';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * RENO-02: scope step renders two enabled project-type cards (New Build +
 * Renovation, no "coming soon"), stores the selection in NGXS, disables the
 * CTA until a card is chosen, and routes per project type (new build →
 * details, renovation → reno scope-inputs). No dollar figures on this step.
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
    fixture = TestBed.createComponent(ScopePageComponent);
    fixture.detectChanges();
  }

  beforeEach(setup);

  function ptypeButton(id: string): HTMLButtonElement {
    return fixture.nativeElement.querySelector(`.ptype-card[data-ptype="${id}"]`);
  }

  function cta(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button.cta');
  }

  function slider(): HTMLInputElement {
    return fixture.nativeElement.querySelector('input.sqft-slider');
  }

  function tierButton(id: string): HTMLButtonElement {
    return fixture.nativeElement.querySelector(`.tier-card[data-tier="${id}"]`);
  }

  /** Selects a project type the way a user would. */
  function chooseCard(id: 'new-build' | 'renovation'): void {
    ptypeButton(id).click();
    fixture.detectChanges();
  }

  it('renders both project-type cards enabled, with no coming-soon badge', () => {
    const cards = fixture.nativeElement.querySelectorAll('.ptype-card');
    expect(cards.length).toBe(2);
    for (const card of cards) {
      expect(card.getAttribute('aria-disabled')).toBeNull();
      expect(card.disabled).toBe(false);
    }
    expect(fixture.nativeElement.textContent).not.toMatch(/coming soon/i);
  });

  it('disables the CTA until a project type is chosen; either card enables it', () => {
    expect(cta().disabled).toBe(true);
    chooseCard('new-build');
    expect(cta().disabled).toBe(false);

    store.dispatch(new ChooseProjectType('renovation'));
    fixture.detectChanges();
    expect(cta().disabled).toBe(false);
  });

  it('card selection writes projectType into the store and marks the card', () => {
    chooseCard('renovation');
    expect(store.selectSnapshot(WizardState.projectType)).toBe('renovation');
    expect(ptypeButton('renovation').getAttribute('aria-checked')).toBe('true');
    expect(ptypeButton('renovation').classList.contains('selected')).toBe(true);
    expect(ptypeButton('new-build').getAttribute('aria-checked')).toBe('false');

    chooseCard('new-build');
    expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
  });

  it('restores the selected card when the component is recreated (refresh/back)', () => {
    chooseCard('renovation');
    const fresh = TestBed.createComponent(ScopePageComponent);
    fresh.detectChanges();
    const reno = fresh.nativeElement.querySelector('.ptype-card[data-ptype="renovation"]');
    expect(reno.getAttribute('aria-checked')).toBe('true');
    expect(fresh.nativeElement.querySelector('button.cta').disabled).toBe(false);
    fresh.destroy();
  });

  it('New Build CTA routes to the details step and records the project type', async () => {
    chooseCard('new-build');
    cta().click();
    await pollUrl('/estimate/details');
    expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
    expect(store.selectSnapshot((s) => s.wizard.step)).toBe(3);
  });

  it('Renovation CTA routes to the reno scope-inputs step and keeps step 2', async () => {
    chooseCard('renovation');
    cta().click();
    await pollUrl('/estimate/reno-scope');
    expect(store.selectSnapshot(WizardState.projectType)).toBe('renovation');
    expect(store.selectSnapshot((s) => s.wizard.step)).toBe(2);
  });

  it('going back from a later step preserves the selected project type', async () => {
    chooseCard('renovation');
    cta().click();
    await pollUrl('/estimate/reno-scope');
    // Back to the scope step (as the reno placeholder's back link does).
    store.dispatch(new GoToStep(2));
    await router.navigate(['/estimate/scope']);
    fixture.detectChanges();
    expect(ptypeButton('renovation').getAttribute('aria-checked')).toBe('true');
  });

  it('arrow keys move the card selection (radiogroup keyboard support)', () => {
    const group = fixture.nativeElement.querySelector('.ptypes');
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');

    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    fixture.detectChanges();
    expect(store.selectSnapshot(WizardState.projectType)).toBe('renovation');
  });

  it('shows new-build inputs only for New Build, and the reno note for Renovation', () => {
    chooseCard('new-build');
    expect(slider()).not.toBeNull();
    expect(tierButton('standard')).not.toBeNull();

    chooseCard('renovation');
    expect(fixture.nativeElement.querySelector('input.sqft-slider')).toBeNull();
    expect(fixture.nativeElement.querySelector('.tier-card')).toBeNull();
    expect(fixture.nativeElement.querySelector('.reno-note')).not.toBeNull();
  });

  it('renders the slider with config bounds and the seeded default (new build)', () => {
    chooseCard('new-build');
    expect(slider().min).toBe('1200');
    expect(slider().max).toBe('4000');
    expect(slider().step).toBe('50');
    expect(slider().value).toBe('2200');
    expect(fixture.nativeElement.textContent).toContain('2,200');
  });

  it('selects the Standard tier by default (new build)', () => {
    chooseCard('new-build');
    const standard = tierButton('standard');
    expect(standard.classList.contains('selected')).toBe(true);
    expect(standard.getAttribute('aria-checked')).toBe('true');
    expect(store.selectSnapshot(WizardState.inputs).tier).toBe('standard');
  });

  it('slider input writes the value into the store, clamped to the range', () => {
    chooseCard('new-build');
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
    chooseCard('new-build');
    tierButton('premium').click();
    fixture.detectChanges();
    expect(store.selectSnapshot(WizardState.inputs).tier).toBe('premium');
    expect(tierButton('premium').getAttribute('aria-checked')).toBe('true');
    expect(tierButton('standard').getAttribute('aria-checked')).toBe('false');
  });

  it('shows no dollar figures in the scope inputs (copy-lint)', () => {
    // The property card legitimately shows the City assessed value; the
    // scope step's own sections must never show $ / sq ft or margin figures.
    const scopeText = (root: ParentNode): string =>
      Array.from(root.querySelectorAll('.scope-section, .reno-note'))
        .map((el) => el.textContent ?? '')
        .join(' ');
    chooseCard('new-build');
    expect(scopeText(fixture.nativeElement)).not.toContain('$');
    chooseCard('renovation');
    expect(scopeText(fixture.nativeElement)).not.toContain('$');
  });

  it('back link returns to the address step', async () => {
    await router.navigate(['/estimate/scope']);
    const back = fixture.nativeElement.querySelector('a.back') as HTMLAnchorElement;
    back.click();
    await pollUrl('/');
    expect(store.selectSnapshot((s) => s.wizard.step)).toBe(1);
  });
});
