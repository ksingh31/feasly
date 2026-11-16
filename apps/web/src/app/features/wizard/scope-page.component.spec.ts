import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { API_SERVICE, type ApiService } from '../../core/api';
import { MOCK_ZONING_DISTRICTS } from '../../core/api/mock-data';
import { ConfigService } from '../../core/config/config.service';
import { ChooseProjectType, GoToStep, SelectProperty, WizardState } from '../wizard';
import { AnalyticsService } from '../consent';
import { ScopePageComponent } from './scope-page.component';
import { provideDataFreshnessStub } from '../../shared/test-helpers/data-freshness.stub';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * RENO-02: scope step renders two enabled project-type cards (New Build +
 * Renovation, no "coming soon"), preselects New Build on first visit, stores
 * the selection in NGXS, and routes per project type (new build → preview,
 * renovation → reno scope-inputs). No dollar figures on this step.
 *
 * Those RENO-02 tests run with `features.renovationWaitlist` off; the #520
 * block at the end covers the flag-on path (badge + waitlist, no reno form).
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

  /** Stubbed API seam: the waitlist and the zoning catalogue (#689). */
  const joinWaitlist = vi.fn((req: { topic: string }) => of({ ok: true as const, topic: req.topic }));
  let catalogueFails = false;
  const getZoningDistricts = vi.fn(() =>
    catalogueFails ? throwError(() => new Error('down')) : of(MOCK_ZONING_DISTRICTS),
  );

  /** Analytics seam (#755): records which steer events fired. */
  const track = vi.fn();

  async function setup(
    renoWaitlist = false,
    opts: { zoning?: string; catalogueFails?: boolean; property?: PropertyRecord } = {},
  ): Promise<void> {
    joinWaitlist.mockClear();
    getZoningDistricts.mockClear();
    track.mockClear();
    catalogueFails = opts.catalogueFails ?? false;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ScopePageComponent, BlankComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideDataFreshnessStub(),
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'estimate/scope', component: BlankComponent },
          { path: 'estimate/preview', component: BlankComponent },
          { path: 'estimate/reno-scope', component: BlankComponent },
        ]),
        provideStore([WizardState]),
        {
          provide: API_SERVICE,
          useValue: { joinWaitlist, getZoningDistricts } as unknown as ApiService,
        },
        { provide: AnalyticsService, useValue: { track } },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock
      .expectOne('/assets/config/app-config.json')
      .flush({
        wizard: { sqftDefault: 2200, sqftMin: 1200, sqftMax: 4000, sqftStep: 50 },
        features: { renovationWaitlist: renoWaitlist },
      });
    await pending;
    store = TestBed.inject(Store);
    router = TestBed.inject(Router);
    const property = opts.property ?? fakeProperty;
    store.dispatch(new SelectProperty(opts.zoning ? { ...property, zoning: opts.zoning } : property));
    fixture = TestBed.createComponent(ScopePageComponent);
    fixture.detectChanges();
  }

  beforeEach(() => setup());

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
    return fixture.nativeElement.querySelector(`.option-card[data-option="${id}"]`);
  }

  /**
   * Option button within one of the three new-build selectors, by DOM order:
   * 0 = finish tier, 1 = garage, 2 = basement. (All three render the same
   * shared markup; the order is fixed in the template.)
   */
  function sectionButton(sectionIndex: number, id: string): HTMLButtonElement {
    const sections = fixture.nativeElement.querySelectorAll('app-option-selector');
    const button = sections[sectionIndex]?.querySelector(`[data-option="${id}"]`);
    if (!button) {
      throw new Error(`no [data-option="${id}"] in option selector #${sectionIndex}`);
    }
    return button as HTMLButtonElement;
  }

  function garageButton(id: string): HTMLButtonElement {
    return sectionButton(1, id);
  }

  function basementButton(id: string): HTMLButtonElement {
    return sectionButton(2, id);
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
    expect(fixture.nativeElement.querySelector('.ptypes').textContent).not.toMatch(/coming soon/i);
  });

  it('preselects New Build on first visit (CTA enabled); cards still switch it', () => {
    expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
    expect(ptypeButton('new-build').getAttribute('aria-checked')).toBe('true');
    expect(cta().disabled).toBe(false);

    chooseCard('renovation');
    expect(store.selectSnapshot(WizardState.projectType)).toBe('renovation');
    expect(cta().disabled).toBe(false);

    chooseCard('new-build');
    expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
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

  it('New Build CTA routes straight to the preview step (#507) and records the project type', async () => {
    chooseCard('new-build');
    cta().click();
    await pollUrl('/estimate/preview');
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
    // New Build is preselected on first visit.
    expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
    const group = fixture.nativeElement.querySelector('.ptypes');
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(store.selectSnapshot(WizardState.projectType)).toBe('renovation');

    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    fixture.detectChanges();
    expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
  });

  it('shows new-build inputs only for New Build, and the reno note for Renovation', () => {
    chooseCard('new-build');
    expect(slider()).not.toBeNull();
    expect(tierButton('standard')).not.toBeNull();

    chooseCard('renovation');
    expect(fixture.nativeElement.querySelector('input.sqft-slider')).toBeNull();
    expect(fixture.nativeElement.querySelector('.option-card')).toBeNull();
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

  it('renders garage and basement selectors with the contract options (new build)', () => {
    chooseCard('new-build');
    // Garage: none / double / triple (GarageOption union).
    for (const id of ['none', 'double', 'triple']) {
      expect(garageButton(id)).not.toBeNull();
    }
    // Basement: unfinished / finished (BasementOption union).
    for (const id of ['unfinished', 'finished']) {
      expect(basementButton(id)).not.toBeNull();
    }
    // Defaults from the wizard state: double garage, unfinished basement.
    expect(garageButton('double').getAttribute('aria-checked')).toBe('true');
    expect(basementButton('unfinished').getAttribute('aria-checked')).toBe('true');
    expect(store.selectSnapshot(WizardState.inputs).garage).toBe('double');
    expect(store.selectSnapshot(WizardState.inputs).basement).toBe('unfinished');
  });

  it('garage selection updates the store and the selected card', () => {
    chooseCard('new-build');
    garageButton('none').click();
    fixture.detectChanges();
    expect(store.selectSnapshot(WizardState.inputs).garage).toBe('none');
    expect(garageButton('none').getAttribute('aria-checked')).toBe('true');
    expect(garageButton('none').classList.contains('selected')).toBe(true);
    expect(garageButton('double').getAttribute('aria-checked')).toBe('false');

    garageButton('triple').click();
    fixture.detectChanges();
    expect(store.selectSnapshot(WizardState.inputs).garage).toBe('triple');
  });

  it('basement selection updates the store and the selected card', () => {
    chooseCard('new-build');
    basementButton('finished').click();
    fixture.detectChanges();
    expect(store.selectSnapshot(WizardState.inputs).basement).toBe('finished');
    expect(basementButton('finished').getAttribute('aria-checked')).toBe('true');
    expect(basementButton('unfinished').getAttribute('aria-checked')).toBe('false');
  });

  it('garage/basement selections survive a component recreate (persisted state)', () => {
    chooseCard('new-build');
    garageButton('triple').click();
    basementButton('finished').click();
    fixture.detectChanges();

    const fresh = TestBed.createComponent(ScopePageComponent);
    fresh.detectChanges();
    const sections = fresh.nativeElement.querySelectorAll('app-option-selector');
    expect(
      sections[1].querySelector('[data-option="triple"]').getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      sections[2].querySelector('[data-option="finished"]').getAttribute('aria-checked'),
    ).toBe('true');
    fresh.destroy();
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
    const back = fixture.nativeElement.querySelector('.wizard-backbar-btn') as HTMLAnchorElement;
    back.click();
    await pollUrl('/');
    expect(store.selectSnapshot((s) => s.wizard.step)).toBe(1);
  });

  describe('#520 renovation waitlist (features.renovationWaitlist on)', () => {
    beforeEach(() => setup(true));

    it('badges the Renovation card "Coming soon" (and only that card)', () => {
      expect(ptypeButton('renovation').querySelector('.ptype-badge')?.textContent?.trim()).toBe(
        'Coming soon',
      );
      expect(ptypeButton('new-build').querySelector('.ptype-badge')).toBeNull();
      // Still selectable: picking it is how people reach the waitlist.
      expect(ptypeButton('renovation').disabled).toBe(false);
    });

    it('Renovation shows the email capture — no reno form, no preview CTA (AC2)', () => {
      chooseCard('renovation');
      const root: HTMLElement = fixture.nativeElement;
      expect(root.querySelector('app-waitlist-signup[variant="renovation"]')).not.toBeNull();
      expect(root.querySelector('button.cta')).toBeNull();
      expect(root.querySelector('.reno-note')).toBeNull();
      expect(root.querySelector('app-sqft-slider')).toBeNull();
    });

    it('submitting the email joins the renovation waitlist', () => {
      chooseCard('renovation');
      const root: HTMLElement = fixture.nativeElement;
      const input = root.querySelector<HTMLInputElement>('.wl-input')!;
      input.value = 'reno@example.com';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      // #740: submit stays disabled until consent is ticked.
      expect(root.querySelector<HTMLButtonElement>('.wl-submit')!.disabled).toBe(true);
      root.querySelector<HTMLInputElement>('.wl-consent input[type="checkbox"]')!.click();
      fixture.detectChanges();
      expect(root.querySelector<HTMLButtonElement>('.wl-submit')!.disabled).toBe(false);
      root.querySelector<HTMLButtonElement>('.wl-submit')!.click();
      fixture.detectChanges();
      expect(joinWaitlist).toHaveBeenCalledWith({
        email: 'reno@example.com',
        topic: 'renovation',
        consent: true,
      });
      expect(root.querySelector('.wl-success')?.textContent).toContain('renovation estimates');
    });

    it('"Start a new-build estimate instead" returns to the working flow', () => {
      chooseCard('renovation');
      fixture.nativeElement.querySelector('.reno-new-build').click();
      fixture.detectChanges();
      expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
      expect(cta()).not.toBeNull();
      expect(slider()).not.toBeNull();
    });

    it('never routes a renovation to the reno scope form', async () => {
      chooseCard('renovation');
      fixture.componentInstance.seePreview();
      await fixture.whenStable();
      expect(router.url).not.toBe('/estimate/reno-scope');
    });
  });
  describe('#689 building-form choice', () => {
    function formCards(): HTMLButtonElement[] {
      return Array.from(fixture.nativeElement.querySelectorAll('.bform-card'));
    }
    function formIds(estimable?: boolean): string[] {
      return formCards()
        .filter((c) => estimable === undefined || c.dataset['estimable'] === String(estimable))
        .map((c) => c.dataset['form']!);
    }
    function formCard(form: string): HTMLButtonElement {
      const card = fixture.nativeElement.querySelector(`.bform-card[data-form="${form}"]`);
      if (!card) throw new Error(`no form card ${form}`);
      return card;
    }

    it('R-C1: single-detached priced, suites "coming soon", nothing else (AC1)', async () => {
      await setup(false, { zoning: 'R-C1' });
      expect(getZoningDistricts).toHaveBeenCalledTimes(1);
      expect(formIds(true)).toEqual(['single-detached']);
      expect(formIds(false)).toEqual(['secondary-suite', 'backyard-suite']);
      expect(formCard('single-detached').getAttribute('aria-checked')).toBe('true');
      expect(formCard('secondary-suite').textContent).toContain('Allowed here, estimate coming soon');
      expect(formCard('single-detached').textContent).not.toContain('coming soon');
      expect(fixture.nativeElement.querySelector('.bform-hint').textContent).toContain('R-C1');
      expect(fixture.nativeElement.querySelector('.bform-hint').textContent).toMatch(/confirm with the City/);
    });

    it('R-C2: semi-detached and duplex shown as "coming soon" (AC1)', async () => {
      await setup(false, { zoning: 'R-C2' });
      expect(formIds(true)).toEqual(['single-detached']);
      expect(formIds(false)).toEqual(
        expect.arrayContaining(['semi-detached', 'duplex']),
      );
      expect(formIds()).not.toContain('rowhouse');
    });

    it('R-CG: additionally shows rowhouse (AC1)', async () => {
      await setup(false, { zoning: 'r-cg' });
      expect(formIds(false)).toEqual(expect.arrayContaining(['semi-detached', 'duplex', 'rowhouse']));
    });

    it.each(['DC', 'ZZ-UNKNOWN'])(
      '%s: fails open — only the estimable form, CTA works, no form sent (AC2)',
      async (zoning) => {
        await setup(false, { zoning });
        expect(formIds()).toEqual(['single-detached']);
        expect(fixture.nativeElement.querySelector('.bform-section').dataset['status']).toBe('fail-open');
        cta().click();
        await pollUrl('/estimate/preview');
        expect(store.selectSnapshot(WizardState.inputs).buildingForm).toBeUndefined();
      },
    );

    it('catalogue unavailable: the choice is hidden and the estimate runs as before', async () => {
      await setup(false, { catalogueFails: true });
      expect(fixture.nativeElement.querySelector('.bform-section')).toBeNull();
      expect(slider()).not.toBeNull();
      cta().click();
      await pollUrl('/estimate/preview');
      expect(store.selectSnapshot(WizardState.inputs).buildingForm).toBeUndefined();
    });

    it('covered lot: the CTA stores the estimable form for the request', async () => {
      await setup(false, { zoning: 'R-C2' });
      cta().click();
      await pollUrl('/estimate/preview');
      expect(store.selectSnapshot(WizardState.inputs).buildingForm).toBe('single-detached');
    });

    it('picking a "coming soon" form shows its waitlist instead of the scope inputs and CTA', async () => {
      await setup(false, { zoning: 'R-C2' });
      formCard('semi-detached').click();
      fixture.detectChanges();
      const root: HTMLElement = fixture.nativeElement;
      expect(formCard('semi-detached').getAttribute('aria-checked')).toBe('true');
      expect(root.querySelector('app-waitlist-signup[variant="building-form"]')).not.toBeNull();
      expect(root.querySelector('.wl-heading')?.textContent).toContain('Semi-detached');
      expect(root.querySelector('.wl-body')?.textContent).toContain('R-C2');
      expect(root.querySelector('button.cta')).toBeNull();
      expect(slider()).toBeNull();
      // Never stored for the estimate request.
      expect(store.selectSnapshot(WizardState.inputs).buildingForm).toBeUndefined();
      fixture.componentInstance.seePreview();
      await fixture.whenStable();
      expect(router.url).not.toBe('/estimate/preview');
    });

    it('the form waitlist records form, district and community (AC5)', async () => {
      await setup(false, { zoning: 'R-CG' });
      formCard('rowhouse').click();
      fixture.detectChanges();
      const root: HTMLElement = fixture.nativeElement;
      const input = root.querySelector<HTMLInputElement>('.wl-input')!;
      input.value = 'row@example.com';
      input.dispatchEvent(new Event('input'));
      root.querySelector<HTMLInputElement>('.wl-consent input[type="checkbox"]')!.click();
      fixture.detectChanges();
      root.querySelector<HTMLButtonElement>('.wl-submit')!.click();
      fixture.detectChanges();
      expect(joinWaitlist).toHaveBeenCalledWith({
        email: 'row@example.com',
        topic: 'building-form',
        consent: true,
        buildingForm: 'rowhouse',
        district: 'R-CG',
        community: 'Mount Pleasant',
      });
      expect(root.querySelector('.wl-success')).not.toBeNull();
    });

    it('"Estimate a single-detached home instead" returns to the priced flow', async () => {
      await setup(false, { zoning: 'R-C2' });
      formCard('duplex').click();
      fixture.detectChanges();
      const back: HTMLButtonElement = fixture.nativeElement.querySelector('.bform-back');
      expect(back.textContent).toContain('single-detached');
      back.click();
      fixture.detectChanges();
      expect(formCard('single-detached').getAttribute('aria-checked')).toBe('true');
      expect(cta()).not.toBeNull();
      expect(slider()).not.toBeNull();
    });

    it('arrow keys move between form cards (radio group)', async () => {
      await setup(false, { zoning: 'R-C1' });
      const group: HTMLElement = fixture.nativeElement.querySelector('.bforms');
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      fixture.detectChanges();
      expect(formCard('secondary-suite').getAttribute('aria-checked')).toBe('true');
      expect(formCard('single-detached').getAttribute('tabindex')).toBe('-1');
    });

    it('shows no dollar figures on the form cards', async () => {
      await setup(false, { zoning: 'R-CG' });
      expect(fixture.nativeElement.querySelector('.bform-section').textContent).not.toMatch(/\$\s?\d/);
    });
  });

  /**
   * #755: the API's home-age steer decides what is offered first. Web holds
   * no rule — these records carry the server-computed steer.
   */
  describe('home-age steer (#755)', () => {
    const steered = (
      yearBuilt: number | null,
      recommended: 'new_build' | 'renovation' | null,
    ): PropertyRecord => ({
      ...fakeProperty,
      addressKey: `steer-${yearBuilt ?? 'unknown'}`,
      yearBuilt,
      steer: {
        redevelopmentCandidate: recommended === null ? null : recommended === 'new_build',
        reason:
          recommended === null
            ? 'year_built_unknown'
            : recommended === 'new_build'
              ? 'age_at_or_over_threshold'
              : 'age_under_threshold',
        recommendedProjectType: recommended,
        homeAgeYears: yearBuilt === null ? null : 2026 - yearBuilt,
        thresholdYears: 25,
      },
    });

    function cardOrder(): string[] {
      return Array.from(fixture.nativeElement.querySelectorAll('.ptype-card')).map(
        (el) => (el as HTMLElement).dataset['ptype'] ?? '',
      );
    }

    function reason(): HTMLElement | null {
      return fixture.nativeElement.querySelector('[data-testid="steer-reason"]');
    }

    function override(): HTMLButtonElement | null {
      return fixture.nativeElement.querySelector('button.steer-override');
    }

    it('defaults a 1962 home to new build, new build card first', async () => {
      await setup(false, { property: steered(1962, 'new_build') });
      expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
      expect(cardOrder()).toEqual(['new-build', 'renovation']);
      expect(reason()?.textContent).toContain('1962');
      expect(override()).toBeNull();
      expect(track).toHaveBeenCalledWith('steer_new_build_offered');
    });

    it('defaults a 2008 home to renovation, card first, with reason and override', async () => {
      await setup(false, { property: steered(2008, 'renovation') });
      expect(store.selectSnapshot(WizardState.projectType)).toBe('renovation');
      expect(cardOrder()).toEqual(['renovation', 'new-build']);
      expect(reason()?.textContent?.trim()).toBe(
        'This home was built in 2008, so renovation is usually the better fit.',
      );
      expect(override()?.textContent?.trim()).toBe('Estimate a new build anyway');
      expect(track).toHaveBeenCalledWith('steer_renovation_offered');
    });

    it('override continues to a normal new-build estimate and is recorded', async () => {
      await setup(false, { property: steered(2008, 'renovation') });
      override()!.click();
      fixture.detectChanges();
      expect(track).toHaveBeenCalledWith('steer_override_new_build');
      expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
      expect(slider()).not.toBeNull();
      expect(override()).toBeNull();
      cta().click();
      await pollUrl('/estimate/preview');
      expect(store.selectSnapshot(WizardState.step)).toBe(3);
    });

    it('records choosing the New Build card over the renovation steer as the override', async () => {
      await setup(false, { property: steered(2008, 'renovation') });
      ptypeButton('new-build').click();
      expect(track).toHaveBeenCalledWith('steer_override_new_build');
    });

    it('shows the override instead of the waitlist fallback CTA while reno is waitlisted', async () => {
      await setup(true, { property: steered(2008, 'renovation') });
      const button = fixture.nativeElement.querySelector('button.reno-new-build') as HTMLButtonElement;
      expect(button.textContent?.trim()).toBe('Estimate a new build anyway');
      button.click();
      fixture.detectChanges();
      expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
      expect(track).toHaveBeenCalledWith('steer_override_new_build');
    });

    it('shows both types equally when the year built is unknown', async () => {
      // A previous property left Renovation selected; the new one has no year.
      await setup(false, { property: steered(2008, 'renovation') });
      track.mockClear();
      store.dispatch(new SelectProperty(steered(null, null)));
      fixture.destroy();
      fixture = TestBed.createComponent(ScopePageComponent);
      fixture.detectChanges();
      expect(store.selectSnapshot(WizardState.projectType)).toBeNull();
      expect(cardOrder()).toEqual(['new-build', 'renovation']);
      expect(reason()).toBeNull();
      expect(override()).toBeNull();
      expect(cta().disabled).toBe(true);
      expect(track).toHaveBeenCalledWith('steer_none_offered');
    });

    it('applies the steer once per property so an explicit pick survives a revisit', async () => {
      const home = steered(2008, 'renovation');
      await setup(false, { property: home });
      ptypeButton('new-build').click();
      track.mockClear();
      // Revisit the step (refresh/back): the stored pick wins, nothing re-offered.
      fixture.destroy();
      fixture = TestBed.createComponent(ScopePageComponent);
      fixture.detectChanges();
      expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
      expect(track).not.toHaveBeenCalledWith('steer_renovation_offered');
    });
  });
});
