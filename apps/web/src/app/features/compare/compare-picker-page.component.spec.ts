import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ComparePickerPageComponent } from './compare-picker-page.component';
import { CommunityService } from '../../core/community';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { API_SERVICE } from '../../core/api/api.service';
import { MockApiService } from '../../core/api/mock-api.service';
import { providePropertyData } from '../../core/api/property-data.service';
import { UpdateComparison, WizardState } from '../wizard';
import { ComparisonState } from './comparison.state';

/**
 * NBH-04 / NBH-03: the comparison picker enforces the 2–3 community rule
 * with the exact story copy, keeps the CTA disabled below two selections,
 * persists through NGXS, and reuses the shared sqft/tier controls.
 * NBH-03: the CTA runs the real pipeline — picker → analyzing (honest
 * stages) → results — replacing the NBH-04 interim placeholder.
 */
describe('ComparePickerPageComponent', () => {
  // The storage plugin persists NGXS state to localStorage — clear it so
  // each test starts from a clean picker.
  beforeEach(() => {
    localStorage.clear();
  });

  async function setup() {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [
        RouterTestingModule.withRoutes([
          { path: 'estimate/compare', component: ComparePickerPageComponent },
        ]),
      ],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        providePropertyData(),
        provideStore([WizardState, ComparisonState]),
        { provide: API_SERVICE, useClass: MockApiService },
        CommunityService,
        ConfigService,
        SeoService,
      ],
    }).compileComponents();
    const httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock
      .expectOne('/assets/config/app-config.json')
      .flush({
        api: { useMockApi: true },
        timings: { debounceMs: 1, mockLatencyMinMs: 1, mockLatencyMaxMs: 1 },
        propertyData: { source: 'mock' },
      });
    await pending;
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

  /** Polls until the predicate holds — never a fixed sleep. */
  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timed out waiting for condition');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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

  it('CTA runs the pipeline: picker → analyzing (honest stages) → results', async () => {
    const { fixture, comp, store } = await setup();
    comp.toggleCommunity('beltline');
    comp.toggleCommunity('cranston');
    fixture.detectChanges();
    await fixture.whenStable();

    comp.startComparison();
    fixture.detectChanges();
    await fixture.whenStable();

    // Analyzing phase: the three honest pipeline stages render.
    expect(comp['phase']()).toBe('analyzing');
    let el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Checking your communities');
    expect(el.textContent).toContain('Fetching City assessed values');
    expect(el.textContent).toContain('Calculating side-by-side costs');

    // Pipeline completes → results phase with the real cards.
    await waitFor(() => comp['phase']() === 'results');
    fixture.detectChanges();
    await fixture.whenStable();
    el = fixture.nativeElement;
    expect(el.querySelector('app-compare-results')).toBeTruthy();
    expect(store.selectSnapshot(ComparisonState.status)).toBe('ready');
  });
});
