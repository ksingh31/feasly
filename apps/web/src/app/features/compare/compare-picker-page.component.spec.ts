import { Component } from '@angular/core';
import { RouterTestingModule } from '@angular/router/testing';
import { TestBed } from '@angular/core/testing';
import { NgxsModule, Store } from '@ngxs/store';
import { NgxsStoragePluginModule } from '@ngxs/storage-plugin';
import { beforeEach } from 'vitest';
import { ComparePickerPageComponent } from './compare-picker-page.component';
import { CommunityService } from '../../core/community';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { UpdateComparison, WizardState } from '../wizard';

/**
 * NBH-04: the comparison picker enforces the 2–3 community rule with the
 * exact story copy, keeps the CTA disabled below two selections, persists
 * through NGXS, reuses the shared sqft/tier controls, and transitions
 * through an explicit interim state (NBH-03 owns the real result pipeline).
 */
describe('ComparePickerPageComponent', () => {
  // The storage plugin persists NGXS state to localStorage — clear it so
  // each test starts from a clean picker.
  beforeEach(() => {
    localStorage.clear();
  });

  async function setup() {
    await TestBed.configureTestingModule({
      imports: [
        RouterTestingModule,
        NgxsModule.forRoot([WizardState]),
        NgxsStoragePluginModule.forRoot({ keys: [WizardState] }),
        ComparePickerPageComponent,
      ],
      providers: [CommunityService, ConfigService, SeoService],
    }).compileComponents();
    const fixture = TestBed.createComponent(ComparePickerPageComponent);
    const comp = fixture.componentInstance;
    const store = TestBed.inject(Store);
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, comp, store };
  }

  function cta(fixture: { nativeElement: HTMLElement }): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button.cta') as HTMLButtonElement;
  }

  it('renders the picker heading and community list', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Compare neighbourhoods');
    expect(el.textContent).toContain('Beltline');
    expect(el.textContent).toContain('Walden');
  });

  it('disables the CTA until two communities are selected', async () => {
    const { fixture, comp, store } = await setup();
    expect(cta(fixture).disabled).toBe(true);
    expect(cta(fixture).textContent).toContain('Compare →');

    store.dispatch(new UpdateComparison({ slugs: ['beltline'] }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(cta(fixture).disabled).toBe(true);

    comp.toggleCommunity('cranston');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(cta(fixture).disabled).toBe(false);
  });

  it('rejects a fourth selection with the exact story copy', async () => {
    const { fixture, comp } = await setup();
    comp.toggleCommunity('beltline');
    comp.toggleCommunity('cranston');
    comp.toggleCommunity('evanston');
    fixture.detectChanges();
    await fixture.whenStable();

    comp.toggleCommunity('mahogany');
    fixture.detectChanges();
    await fixture.whenStable();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('You can compare up to 3 communities.');
    // The fourth slug was not added.
    expect(comp['comparison']().slugs).toEqual(['beltline', 'cranston', 'evanston']);
  });

  it('deselecting clears the max warning', async () => {
    const { fixture, comp } = await setup();
    comp.toggleCommunity('beltline');
    comp.toggleCommunity('cranston');
    comp.toggleCommunity('evanston');
    comp.toggleCommunity('mahogany'); // rejected
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('You can compare up to 3 communities.');

    comp.toggleCommunity('beltline'); // deselect one
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).not.toContain('You can compare up to 3 communities.');
  });

  it('persists selections to NGXS (survives a component rebuild)', async () => {
    const { comp, store } = await setup();
    comp.toggleCommunity('beltline');
    comp.toggleCommunity('cranston');
    comp.onSqftInput(2500);
    comp.onTierChange('premium');

    const snapshot = store.selectSnapshot(WizardState.comparison);
    expect(snapshot.slugs).toEqual(['beltline', 'cranston']);
    expect(snapshot.sqft).toBe(2500);
    expect(snapshot.tier).toBe('premium');

    // A fresh component instance reads the same persisted state.
    const fixture2 = TestBed.createComponent(ComparePickerPageComponent);
    fixture2.detectChanges();
    await fixture2.whenStable();
    const comp2 = fixture2.componentInstance;
    expect(comp2['comparison']().slugs).toEqual(['beltline', 'cranston']);
    expect(comp2['comparison']().sqft).toBe(2500);
  });

  it('reuses the shared sqft slider and tier selector (no duplicated controls)', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('app-sqft-slider')).toBeTruthy();
    expect(el.querySelector('app-tier-selector')).toBeTruthy();
  });

  it('filters the community list by search text', async () => {
    const { fixture, comp } = await setup();
    comp.onSearchInput({ target: { value: 'belt' } } as unknown as Event);
    fixture.detectChanges();
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Beltline');
    expect(el.textContent).not.toContain('Walden');
  });

  it('CTA moves to the explicit interim state (not a fake result)', async () => {
    const { fixture, comp } = await setup();
    comp.toggleCommunity('beltline');
    comp.toggleCommunity('cranston');
    fixture.detectChanges();
    await fixture.whenStable();

    comp.startComparison();
    fixture.detectChanges();
    await fixture.whenStable();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Your comparison is on its way');
    expect(el.textContent).toContain('Beltline');
    expect(el.textContent).toContain('Cranston');
    // Honest placeholder: no dollar figures anywhere.
    expect(el.textContent).not.toMatch(/\$\d/);
  });

  it('interim panel back button returns to the picker', async () => {
    const { fixture, comp } = await setup();
    comp.toggleCommunity('beltline');
    comp.toggleCommunity('cranston');
    comp.startComparison();
    fixture.detectChanges();
    await fixture.whenStable();

    comp.backToPicker();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-sqft-slider')).toBeTruthy();
  });

  it('does nothing on CTA when fewer than two are selected', async () => {
    const { comp } = await setup();
    comp.startComparison();
    expect(comp['submitted']()).toBe(false);
  });
});
