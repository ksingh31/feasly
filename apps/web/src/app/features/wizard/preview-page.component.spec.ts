import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PreviewEstimateResponse, PropertyRecord } from '@feasly/contracts';
import { API_SERVICE, provideApi } from '../../core/api/api.service';
import { MockApiService } from '../../core/api/mock-api.service';
import { providePropertyData } from '../../core/api/property-data.service';
import { ConfigService } from '../../core/config/config.service';
import { SelectProperty, StorePreviewEstimate, UpdateInputs, WizardState } from '../wizard';
import { ReportState } from '../report/report.state';
import { PreviewPageComponent } from './preview-page.component';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * S5 estimate preview step: the single lead-gate point. Visible: address,
 * community, lot size, zoning, assessed value + chosen sqft/tier. Blurred
 * (CSS-only placeholders + lock note): build cost range, total project
 * range. The one "Unlock" CTA routes to the gate; "← Back to details"
 * returns to S3. No real dollar figures may appear in the figures section.
 */
describe('PreviewPageComponent', () => {
  let fixture: ComponentFixture<PreviewPageComponent>;
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

  const baseConfig = {
    api: { useMockApi: true },
    timings: { debounceMs: 1, mockLatencyMinMs: 1, mockLatencyMaxMs: 1 },
    wizard: { sqftDefault: 2200, sqftMin: 1200, sqftMax: 4000, sqftStep: 50 },
  };

  const text = (): string => fixture.nativeElement.textContent ?? '';

  async function pollFor(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 8000;
    for (;;) {
      fixture.detectChanges();
      if (predicate()) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [PreviewPageComponent, BlankComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'estimate/preview', component: PreviewPageComponent },
          { path: 'estimate/details', component: BlankComponent },
          { path: 'estimate/gate', component: BlankComponent },
        ]),
        provideStore([WizardState, ReportState]),
        providePropertyData(),
        { provide: API_SERVICE, useClass: MockApiService },
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush(baseConfig);
    await pending;
    store = TestBed.inject(Store);
    store.dispatch([new SelectProperty(fakeProperty), new UpdateInputs({ sqft: 2200, tier: 'premium' })]);
    fixture = TestBed.createComponent(PreviewPageComponent);
    fixture.detectChanges();
    await pollFor(() => store.selectSnapshot(ReportState.status) === 'ready', 'preview load');
  }

  beforeEach(async () => {
    await setup();
  });

  it('dispatches LoadPreview on init and renders the blurred preview', () => {
    expect(store.selectSnapshot(ReportState.preview)).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.blur-bar').length).toBe(2);
    expect(text()).toContain('Your numbers are ready.');
  });

  it('shows the visible estimate basis: property facts + chosen sqft/tier', () => {
    expect(text()).toContain('918 16 Ave NW, Calgary, AB');
    expect(text()).toContain('2,200 sq ft');
    // Tier renders capitalized via CSS (.cap); textContent keeps the raw value.
    const tierDd = fixture.nativeElement.querySelector('.inputs-summary .cap') as HTMLElement;
    expect(tierDd?.textContent?.trim()).toBe('premium');
    expect(getComputedStyle(tierDd).textTransform).toBe('capitalize');
  });

  it('blurs the build/total figures with no real dollar figures in the figures section', () => {
    const figures = fixture.nativeElement.querySelector('.figures') as HTMLElement;
    expect(figures).toBeTruthy();
    // CSS-only placeholders: no fake figures in markup, no real ones either.
    expect(figures.querySelectorAll('.blur-value').length).toBe(2);
    expect(figures.textContent).not.toContain('$');
    // Every real estimate figure is >= 100000, so no 6+ digit run may
    // appear inside the figures section (assessed value lives outside it).
    expect(figures.textContent).not.toMatch(/\d{6}/);
  });

  it('renders the single "Unlock" CTA toward the gate', () => {
    const unlock = fixture.nativeElement.querySelector('a.cta.unlock') as HTMLAnchorElement;
    expect(unlock?.textContent).toContain('Unlock my full report');
    expect(unlock?.getAttribute('href')).toBe('/estimate/gate');
  });

  it('reserves "Unlock" for the preview-to-gate CTA', () => {
    const matches = [...fixture.nativeElement.querySelectorAll('a, button')].filter((el: Element) =>
      el.textContent?.includes('Unlock'),
    );
    expect(matches.length).toBe(1);
    expect((matches[0] as HTMLAnchorElement).getAttribute('href')).toBe('/estimate/gate');
  });

  it('links back to the details step', () => {
    const back = fixture.nativeElement.querySelector('a.back') as HTMLAnchorElement;
    expect(back?.textContent).toContain('Back to details');
    expect(back?.getAttribute('href')).toBe('/estimate/details');
  });

  it('shows the tier what-if as locked behind the gate', () => {
    expect(text()).toContain('Unlock your report to explore finish tiers.');
  });

  it('preview copy carries no ±, %, or accuracy claim (copy-lint)', () => {
    const config = TestBed.inject(ConfigService);
    const dump = JSON.stringify(config.get('copy').preview);
    expect(dump).not.toMatch(/[±%]/);
    expect(dump.toLowerCase()).not.toContain('accura');
  });
});

describe('PreviewPageComponent loading state', () => {
  it('shows a loading indicator while the preview resolves', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [PreviewPageComponent, BlankComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '', component: BlankComponent }]),
        provideStore([WizardState, ReportState]),
        providePropertyData(),
        { provide: API_SERVICE, useClass: MockApiService },
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({
      api: { useMockApi: true },
      timings: { debounceMs: 1, mockLatencyMinMs: 50, mockLatencyMaxMs: 50 },
      wizard: { sqftDefault: 2200, sqftMin: 1200, sqftMax: 4000, sqftStep: 50 },
    });
    await pending;
    const store = TestBed.inject(Store);
    store.dispatch([
      // Complete record: the property card renders as soon as a property
      // exists, even while the preview is still loading.
      new SelectProperty({
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
      } as PropertyRecord),
      new UpdateInputs({ sqft: 2200 }),
    ]);
    const fixture = TestBed.createComponent(PreviewPageComponent);
    fixture.detectChanges();
    // LoadPreview was dispatched synchronously in ngOnInit; the mock's
    // 50ms latency means the loading indicator is visible now.
    expect(fixture.nativeElement.querySelector('.loading')).toBeTruthy();
    TestBed.resetTestingModule();
  });

  describe('reno preview (RENO-04)', () => {
    async function setupReno(): Promise<ComponentFixture<PreviewPageComponent>> {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [PreviewPageComponent],
        providers: [
          provideHttpClient(),
          provideHttpClientTesting(),
          provideApi(),
          providePropertyData(),
          provideStore([WizardState, ReportState]),
          provideRouter([]),
        ],
      });
      const httpMock = TestBed.inject(HttpTestingController);
      const config = TestBed.inject(ConfigService);
      const pending = config.load();
      httpMock.expectOne('/assets/config/app-config.json').flush({
        propertyData: { source: 'mock' },
        wizard: { sqftDefault: 2200, sqftMin: 1200, sqftMax: 4000, sqftStep: 50 },
      });
      await pending;
      const store = TestBed.inject(Store);
      const { ChooseProjectType, UpdateRenoInputs } = await import('./wizard.actions');
      store.dispatch([
        new SelectProperty({
          addressKey: 'calgary-1234-14-st-nw',
          address: '1234 14 St NW, Calgary, AB',
          community: 'Capitol Hill',
          lotSqft: 5000,
          zoning: 'R-CG',
          assessedValue: 729000,
          assessmentYear: 2025,
          yearBuilt: 1978,
          dataAsOf: '2025-07-01',
          stale: false,
        } as PropertyRecord),
        new ChooseProjectType('renovation'),
        new UpdateRenoInputs({
          renoType: 'basement',
          renoSqft: 800,
          tier: 'premium',
          underpinning: false,
        }),
      ]);
      const fixture = TestBed.createComponent(PreviewPageComponent);
      fixture.detectChanges();
      // Wait for the preview to load (LoadPreview dispatched on init)
      const deadline = Date.now() + 8000;
      for (;;) {
        fixture.detectChanges();
        if (fixture.nativeElement.querySelector('.figures')) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error('timed out waiting for reno preview');
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return fixture;
    }

    it('shows reno-specific visible facts (reno type, affected sqft, tier)', async () => {
      const fixture = await setupReno();
      const summary = fixture.nativeElement.querySelector('.inputs-summary') as HTMLElement;
      expect(summary.textContent).toContain('Basement');
      expect(summary.textContent).toContain('800');
      expect(summary.textContent).toContain('premium');
      TestBed.resetTestingModule();
    });

    it('has no $+digits in blurred regions pre-gate (DOM-leak test)', async () => {
      const fixture = await setupReno();
      const figures = fixture.nativeElement.querySelector('.figures') as HTMLElement;
      expect(figures).toBeTruthy();
      // RENO-04 AC2: no real numbers in the DOM pre-gate — check for $ followed by digits
      expect(figures.textContent).not.toMatch(/\$\d/);
      TestBed.resetTestingModule();
    });

    it('back link returns to reno scope step for reno', async () => {
      const fixture = await setupReno();
      const back = fixture.nativeElement.querySelector('a.back') as HTMLAnchorElement;
      expect(back?.getAttribute('href')).toBe('/estimate/reno-scope');
      TestBed.resetTestingModule();
    });
  });
});
