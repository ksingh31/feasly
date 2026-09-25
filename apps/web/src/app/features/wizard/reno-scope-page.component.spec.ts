import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import {
  ChooseProjectType,
  SelectProperty,
  UpdateRenoInputs,
  WizardState,
} from '../wizard';
import { RenoScopePageComponent } from './reno-scope-page.component';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * RENO-03: reno scope-inputs step renders the 4 reno-type cards, sqft
 * slider + numeric input (addition caps at 400 with the exact note), finish
 * tier, conditional underpinning toggle, and the permit/contingency helper
 * line. CTA stays disabled until reno type + sqft + tier are set. State
 * persists via NGXS storage-plugin. No dollar figures on this step.
 */
describe('RenoScopePageComponent', () => {
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<RenoScopePageComponent>;
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

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [RenoScopePageComponent, BlankComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'estimate/scope', component: BlankComponent },
          { path: 'estimate/reno-scope', component: RenoScopePageComponent },
          { path: 'estimate/analyzing', component: BlankComponent },
        ]),
        provideStore([WizardState]),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({
      wizard: {
        sqftDefault: 2200,
        sqftMin: 1200,
        sqftMax: 4000,
        sqftStep: 50,
        renoSqftDefault: 800,
        renoSqftMin: 200,
        renoSqftMax: 3000,
        renoSqftStep: 50,
        renoAdditionCap: 400,
      },
    });
    await pending;
    store = TestBed.inject(Store);
    router = TestBed.inject(Router);
    store.dispatch([new SelectProperty(fakeProperty), new ChooseProjectType('renovation')]);
    fixture = TestBed.createComponent(RenoScopePageComponent);
    fixture.detectChanges();
  }

  beforeEach(setup);

  function renoCard(id: string): HTMLButtonElement {
    return fixture.nativeElement.querySelector(`.reno-card[data-reno-type="${id}"]`);
  }

  function cta(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button.cta');
  }

  function sqftSlider(): HTMLInputElement {
    return fixture.nativeElement.querySelector('input.sqft-slider');
  }

  function sqftNumber(): HTMLInputElement {
    return fixture.nativeElement.querySelector('input.sqft-number');
  }

  function tierButton(id: string): HTMLButtonElement {
    return fixture.nativeElement.querySelector(`.tier-card[data-tier="${id}"]`);
  }

  function underpinningToggle(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('.underpinning-toggle');
  }

  it('renders all four reno-type cards', () => {
    for (const id of ['extensive', 'addition', 'basement', 'combined']) {
      expect(renoCard(id)).toBeTruthy();
    }
  });

  it('CTA is disabled until reno type + sqft + tier are set', () => {
    // Fresh state: renoType null → disabled.
    expect(cta().disabled).toBe(true);
    renoCard('extensive').click();
    fixture.detectChanges();
    // renoType set, sqft defaults to 800, tier defaults to standard → enabled.
    expect(cta().disabled).toBe(false);
  });

  it('underpinning toggle appears only for basement/combined', () => {
    renoCard('extensive').click();
    fixture.detectChanges();
    expect(underpinningToggle()).toBeNull();

    renoCard('basement').click();
    fixture.detectChanges();
    expect(underpinningToggle()).toBeTruthy();

    renoCard('combined').click();
    fixture.detectChanges();
    expect(underpinningToggle()).toBeTruthy();

    renoCard('addition').click();
    fixture.detectChanges();
    expect(underpinningToggle()).toBeNull();
  });

  it('switching away from basement clears underpinning', () => {
    renoCard('basement').click();
    fixture.detectChanges();
    underpinningToggle()!.click();
    fixture.detectChanges();
    expect(store.selectSnapshot(WizardState.renoInputs).underpinning).toBe(true);

    renoCard('extensive').click();
    fixture.detectChanges();
    expect(store.selectSnapshot(WizardState.renoInputs).underpinning).toBe(false);
  });

  it('addition sqft clamps at 400 with the exact cap note', () => {
    renoCard('addition').click();
    fixture.detectChanges();

    const input = sqftNumber();
    input.value = '600';
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(store.selectSnapshot(WizardState.renoInputs).renoSqft).toBe(400);
    const note = fixture.nativeElement.querySelector('.clamp-note');
    expect(note?.textContent).toContain('Additions over 400 sq ft are quoted as custom projects');
  });

  it('slider and numeric input stay in sync', () => {
    renoCard('extensive').click();
    fixture.detectChanges();

    const slider = sqftSlider();
    slider.value = '1200';
    slider.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(store.selectSnapshot(WizardState.renoInputs).renoSqft).toBe(1200);
    expect(sqftNumber().value).toBe('1200');
  });

  it('shows the permit/contingency helper line', () => {
    const note = fixture.nativeElement.querySelector('.permit-note');
    expect(note?.textContent).toContain('Most renovations need a City permit and a 10–15% contingency');
  });

  it('back link returns to the scope step', async () => {
    const back = fixture.nativeElement.querySelector('a.back') as HTMLAnchorElement;
    expect(back.getAttribute('routerLink')).toBe('/estimate/scope');
  });
});
