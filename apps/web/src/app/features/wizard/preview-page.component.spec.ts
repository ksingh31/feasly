import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { throwError } from 'rxjs';
import type { PreviewEstimateResponse, PropertyRecord } from '@feasly/contracts';
import { API_SERVICE, provideApi, type ApiService } from '../../core/api/api.service';
import { MockApiService } from '../../core/api/mock-api.service';
import { providePropertyData } from '../../core/api/property-data.service';
import { ConfigService } from '../../core/config/config.service';
import { SelectProperty, StorePreviewEstimate, UpdateInputs, WizardState } from '../wizard';
import { ReportState } from '../report/report.state';
import { EmbedState } from '../embed/embed.state';
import { PreviewPageComponent } from './preview-page.component';
import { provideDataFreshnessStub } from '../../shared/test-helpers/data-freshness.stub';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * S5 estimate preview step: the single lead-gate point. Visible: address,
 * community, lot size, zoning, assessed value + chosen sqft/tier. Blurred
 * (CSS-only placeholders + lock note): build cost range, total project
 * range. The one "Unlock" CTA routes to the gate. #507: the Details step is
 * gone — a one-line recap chip with Edit replaces the property card + recap
 * above the figures, "← Back to scope" / Edit return to the scope step, and
 * /estimate/details redirects here without losing wizard state.
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
        provideDataFreshnessStub(),
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'estimate/preview', component: PreviewPageComponent },
          { path: 'estimate/details', redirectTo: 'estimate/preview', pathMatch: 'full' },
          { path: 'estimate/scope', component: BlankComponent },
          { path: 'estimate/gate', component: BlankComponent },
        ]),
        provideStore([WizardState, ReportState, EmbedState]),
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

  it('dispatches LoadPreview on init and renders the blurred real figures', () => {
    expect(store.selectSnapshot(ReportState.preview)).not.toBeNull();
    // Locked numbers: real computed digits behind CSS blur (no shimmer bars).
    const lockedValues = fixture.nativeElement.querySelectorAll('.locked-value');
    expect(lockedValues.length).toBe(2); // blurred "most likely" (#504) + build; #835 total range is clear
    lockedValues.forEach((el: HTMLElement) => {
      expect(el.getAttribute('aria-hidden')).toBe('true');
      // Real digits present in the DOM — the blur hides them visually.
      expect(el.textContent).toMatch(/\$\d/);
      // Blurred via CSS (8px), not an animated placeholder.
      expect(getComputedStyle(el).filter).toContain('blur');
    });
    expect(text()).toContain('Your numbers are ready.');
  });

  it('collapses the estimate basis into a one-line recap chip with Edit (#507)', () => {
    const chip = fixture.nativeElement.querySelector('.recap-chip') as HTMLElement;
    expect(chip.querySelector('.recap-text')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '918 16 Ave NW, Calgary, AB · 2,200 sq ft · Premium',
    );
    // Only the address may truncate; size and tier never do.
    expect(chip.querySelector('.recap-address')?.textContent?.trim()).toBe('918 16 Ave NW, Calgary, AB');
    const edit = chip.querySelector('a.recap-edit') as HTMLAnchorElement;
    expect(edit.textContent?.trim()).toBe('Edit');
    expect(edit.getAttribute('href')).toBe('/estimate/scope');
    expect(edit.getAttribute('aria-label')).toBe('Edit your home details');
    // The old multi-row recap is gone.
    expect(fixture.nativeElement.querySelector('.inputs-summary')).toBeNull();
  });

  it('leads with the locked totals and CTA; the property card follows the CTA (#507)', () => {
    const el = fixture.nativeElement as HTMLElement;
    const chip = el.querySelector('.recap-chip')!;
    const total = el.querySelector('.hero-total')!;
    const cta = el.querySelector('a.cta.unlock')!;
    const build = el.querySelector('.build-card')!;
    const card = el.querySelector('app-property-card')!;
    expect(card).toBeTruthy();
    const follows = (a: Element, b: Element): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(chip, total)).toBe(true);
    // CTA sits right under the total (before the build card) so both land
    // in the first 390×844 viewport.
    expect(follows(total, cta)).toBe(true);
    expect(follows(cta, build)).toBe(true);
    expect(follows(build, card)).toBe(true);
    // City-assessed facts are still on the page, just below the payoff.
    expect(card.textContent).toContain('R-C1');
  });

  it('shows step 3 "Estimate" of Address → Your home → Estimate (#507)', () => {
    const labels = Array.from(
      fixture.nativeElement.querySelectorAll('.steps .step-label'),
      (n: Element) => n.textContent?.trim(),
    );
    expect(labels).toEqual(['Address', 'Your home', 'Estimate']);
    const current = fixture.nativeElement.querySelector('.step-current .step-label');
    expect(current?.textContent?.trim()).toBe('Estimate');
  });

  it('Edit returns to the scope step and moves the wizard to step 2', async () => {
    const edit = fixture.nativeElement.querySelector('a.recap-edit') as HTMLAnchorElement;
    edit.click();
    expect(store.selectSnapshot(WizardState.step)).toBe(2);
    const router = TestBed.inject(Router);
    await pollFor(() => router.url === '/estimate/scope', 'scope navigation');
    // Inputs survive the round-trip.
    expect(store.selectSnapshot(WizardState.inputs).sqft).toBe(2200);
  });

  it('redirects /estimate/details to the preview without losing state (#507)', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/estimate/details');
    expect(router.url).toBe('/estimate/preview');
    expect(store.selectSnapshot(WizardState.property)?.address).toBe('918 16 Ave NW, Calgary, AB');
    expect(store.selectSnapshot(WizardState.inputs)).toMatchObject({ sqft: 2200, tier: 'premium' });
  });

  it('#835: shows the total range in the clear; most likely + build stay blurred', () => {
    const figures = fixture.nativeElement.querySelector('.figures') as HTMLElement;
    expect(figures).toBeTruthy();
    // #835 (owner, 2026-11-15): the engine's total range is readable pre-gate.
    const totalRange = figures.querySelector('.hero-total .total-range') as HTMLElement;
    expect(totalRange.getAttribute('aria-hidden')).toBeNull();
    expect(getComputedStyle(totalRange).filter).not.toContain('blur');
    expect(figures.querySelector('.hero-total .total-note')?.textContent).toContain('City-assessed lot value');
    // The rest of the full estimate stays blurred — real digits in the DOM,
    // aria-hidden and unselectable. No animated placeholder bars remain.
    const lockedValues = figures.querySelectorAll('.locked-value');
    expect(lockedValues.length).toBe(2); // blurred "most likely" (#504) + build
    lockedValues.forEach((el) => {
      expect(el.getAttribute('aria-hidden')).toBe('true');
      expect(el.textContent).toMatch(/\$\d/);
      expect(getComputedStyle(el).filter).toContain('blur');
      expect(getComputedStyle(el).userSelect).toBe('none');
    });
    expect(figures.querySelectorAll('.blur-bar').length).toBe(0);
    // #504: range-first and rounded — the total range is the hero line,
    // "most likely" secondary, and no figure is unrounded.
    const [mostLikely, build] = Array.from(lockedValues).map((el) => el.textContent?.trim() ?? '');
    const total = totalRange.textContent?.trim() ?? '';
    expect(total).toMatch(/^\$[\d.,]+M? – \$[\d.,]+M?$/);
    expect(mostLikely).toMatch(/^Most likely ≈ \$[\d.,]+M?$/);
    expect(build).toMatch(/ – /);
    for (const amount of [total, mostLikely, build].join(' ').match(/\$[\d,.]+M?/g) ?? []) {
      expect(amount).toMatch(/^\$\d+\.\d{2}M$|^\$[\d,]*,000$/);
    }
  });

  describe('#835 address overview before the gate', () => {
    const overview = (): HTMLElement => fixture.nativeElement.querySelector('.overview') as HTMLElement;

    it('shows the district and what it typically allows (from the zoning guide)', () => {
      expect(overview().querySelector('h2')?.textContent?.trim()).toBe('About this address');
      expect(overview().querySelector('.overview-district')?.textContent?.trim()).toBe('R-C1');
      expect(overview().querySelector('.overview-allows')?.textContent).toContain('Single-detached homes');
      expect(overview().querySelector('.overview-note')?.textContent).toContain('confirm the current one with the City');
      // No dollar figures in the free overview.
      expect(overview().textContent).not.toMatch(/\$\d/);
    });

    it('prefers the City land-use district and matches grouped zoning-guide codes', async () => {
      store.dispatch(
        new SelectProperty({
          ...fakeProperty,
          zoning: 'R-CG',
          landUse: { district: 'R-1s', description: 'Residential – One Dwelling', source: 'land-use-districts', asOf: '2026-08-01' },
        }),
      );
      fixture.detectChanges();
      expect(overview().querySelector('.overview-district')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'R-1s · Residential – One Dwelling',
      );
      expect(overview().querySelector('.overview-allows')?.textContent).toContain('R-1s adds a secondary suite');
    });

    it('hides the allowed row for a district the guide does not list', () => {
      store.dispatch(new SelectProperty({ ...fakeProperty, zoning: 'X-UNKNOWN' }));
      fixture.detectChanges();
      expect(overview().querySelector('.overview-district')?.textContent?.trim()).toBe('X-UNKNOWN');
      expect(overview().querySelector('.overview-allows')).toBeNull();
    });

    it('shows the redevelop/renovate steer when the API sent one', () => {
      expect(overview().querySelector('.overview-steer')).toBeNull();
      store.dispatch(
        new SelectProperty({
          ...fakeProperty,
          steer: {
            redevelopmentCandidate: true,
            reason: 'age_at_or_over_threshold',
            recommendedProjectType: 'new_build',
            homeAgeYears: 52,
            thresholdYears: 40,
          },
        }),
      );
      fixture.detectChanges();
      expect(overview().querySelector('.overview-steer')?.textContent?.trim()).toBe(
        'This home was built in 1974, so a new build is usually worth a look.',
      );
    });

    it('shows the typical build timeline', () => {
      const timeline = fixture.nativeElement.querySelector('.timeline-card app-build-timeline') as HTMLElement;
      expect(timeline).toBeTruthy();
      expect(timeline.querySelectorAll('.bt-phase').length).toBeGreaterThan(0);
    });
  });

  it('renders the single "Unlock" CTA toward the gate', () => {
    const unlock = fixture.nativeElement.querySelector('a.cta.unlock') as HTMLAnchorElement;
    expect(unlock?.textContent).toContain('Unlock my free report');
    expect(unlock?.getAttribute('href')).toBe('/estimate/gate');
  });

  it('reserves "Unlock" for the preview-to-gate CTA', () => {
    const matches = [...fixture.nativeElement.querySelectorAll('a, button')].filter((el: Element) =>
      el.textContent?.includes('Unlock'),
    );
    expect(matches.length).toBe(1);
    expect((matches[0] as HTMLAnchorElement).getAttribute('href')).toBe('/estimate/gate');
  });

  it('links back to the scope step (no Details step, #507)', () => {
    const back = fixture.nativeElement.querySelector('.wizard-backbar-btn') as HTMLAnchorElement;
    expect(back?.textContent).toContain('Back to scope');
    expect(back?.getAttribute('href')).toBe('/estimate/scope');
  });

  it('prompts the gate without promising finish-tier exploration', () => {
    // consumer/04 removed the tier what-if toggle from the report — the
    // preview must not promise it.
    expect(text()).toContain('Your full report adds the cost breakdown and next steps.');
    expect(text()).not.toContain('explore finish tiers');
  });

  it('lists what the estimate includes and leaves out, with no figures (#824)', () => {
    const scope = fixture.nativeElement.querySelector('.scope-card app-estimate-scope') as HTMLElement;
    expect(scope).not.toBeNull();
    expect(scope.textContent).toContain('What this estimate includes');
    expect(scope.textContent).toContain('Site preparation & excavation');
    expect(scope.textContent).toContain('Not included');
    expect(scope.textContent).not.toMatch(/\$\d/);
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
        provideDataFreshnessStub(),
        provideRouter([{ path: '', component: BlankComponent }]),
        provideStore([WizardState, ReportState, EmbedState]),
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
        provideDataFreshnessStub(),
          provideApi(),
          providePropertyData(),
          provideStore([WizardState, ReportState, EmbedState]),
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
      const chip = fixture.nativeElement.querySelector('.recap-chip') as HTMLElement;
      expect(chip.querySelector('.recap-text')?.textContent?.replace(/\s+/g, ' ').trim()).toMatch(
        /^1234 14 St NW, Calgary, AB · .*Basement.* · 800 sq ft · Premium$/,
      );
      expect(chip.querySelector('a.recap-edit')?.getAttribute('href')).toBe('/estimate/reno-scope');
      TestBed.resetTestingModule();
    });

    it('omits the new-build includes / not-included lists (#824)', async () => {
      const fixture = await setupReno();
      expect(fixture.nativeElement.querySelector('app-estimate-scope')).toBeNull();
      TestBed.resetTestingModule();
    });

    it('shows the real computed digits blurred in locked regions pre-gate', async () => {
      const fixture = await setupReno();
      const figures = fixture.nativeElement.querySelector('.figures') as HTMLElement;
      expect(figures).toBeTruthy();
      // RENO-04 AC2 (updated 2026-09-26): the real computed digits ARE in
      // the DOM pre-gate — blurred via CSS, aria-hidden, and unselectable.
      const lockedValues = figures.querySelectorAll('.locked-value');
      expect(lockedValues.length).toBe(2); // blurred "most likely" (#504) + build; #835 total range is clear
      expect(figures.querySelector('.total-range')?.textContent).toMatch(/\$\d/);
      lockedValues.forEach((el) => {
        expect(el.getAttribute('aria-hidden')).toBe('true');
        expect(el.textContent).toMatch(/\$\d/);
        expect(getComputedStyle(el).filter).toContain('blur');
        expect(getComputedStyle(el).userSelect).toBe('none');
      });
      TestBed.resetTestingModule();
    });

    it('back link returns to reno scope step for reno', async () => {
      const fixture = await setupReno();
      const back = fixture.nativeElement.querySelector('.wizard-backbar-btn') as HTMLAnchorElement;
      expect(back?.getAttribute('href')).toBe('/estimate/reno-scope');
      TestBed.resetTestingModule();
    });

    it('back link says "Back to scope" (not "details") for reno', async () => {
      const fixture = await setupReno();
      const back = fixture.nativeElement.querySelector('.wizard-backbar-btn') as HTMLAnchorElement;
      expect(back?.textContent).toContain('Back to scope');
      expect(back?.textContent).not.toContain('Back to details');
      TestBed.resetTestingModule();
    });
  });
});

describe('PreviewPageComponent validation failure (consumer/06)', () => {
  const oversizedProperty = {
    addressKey: 'calgary-9999-40-st-se',
    address: '9999 40 St SE, Calgary, AB',
    community: 'Test Community',
    lotSqft: 643811,
    zoning: 'DC',
    assessedValue: 61580000,
    assessmentYear: 2025,
    yearBuilt: 1960,
    dataAsOf: '2025-07-01',
    stale: false,
  } as PropertyRecord;

  /** API stub whose preview call fails with the given ApiError envelope. */
  function failingApi(message: string, retryable: boolean): ApiService {
    return {
      getPreviewEstimate: () =>
        throwError(() => ({ code: 'VALIDATION_FAILED', message, retryable })),
    } as unknown as ApiService;
  }

  async function setupFailure(
    message: string,
    retryable: boolean,
  ): Promise<{ fixture: ComponentFixture<PreviewPageComponent>; store: Store }> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [PreviewPageComponent, BlankComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideDataFreshnessStub(),
        provideRouter([{ path: '', component: BlankComponent }]),
        provideStore([WizardState, ReportState, EmbedState]),
        providePropertyData(),
        { provide: API_SERVICE, useValue: failingApi(message, retryable) },
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({
      api: { useMockApi: true },
      wizard: { sqftDefault: 2200, sqftMin: 1200, sqftMax: 4000, sqftStep: 50 },
    });
    await pending;
    const store = TestBed.inject(Store);
    store.dispatch([new SelectProperty(oversizedProperty), new UpdateInputs({ sqft: 2200 })]);
    const fixture = TestBed.createComponent(PreviewPageComponent);
    fixture.detectChanges();
    const deadline = Date.now() + 8000;
    for (;;) {
      fixture.detectChanges();
      if (store.selectSnapshot(ReportState.status) === 'error') {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the validation error');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { fixture, store };
  }

  it('explains a validation rejection in plain English with no retry button', async () => {
    // Lot size NEVER blocks (Karan, 2026-09-28): the engine prices any lot,
    // so every validation failure renders the generic explanation.
    const { fixture, store } = await setupFailure('assessedLandValue outside configured bounds', false);
    expect(store.selectSnapshot(ReportState.error)).toBe('validation');
    const card = fixture.nativeElement.querySelector('.error-card') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('We can’t price this property yet');
    expect(card.textContent).toContain('falls outside the range our cost data covers');
    // The API detail is translated, never rendered verbatim.
    expect(card.textContent).not.toContain('assessedLandValue');
    // No misleading retry — retry cannot succeed for a validation failure.
    expect(card.querySelector('button')).toBeNull();
    expect(card.textContent).not.toMatch(/try again/i);
    const back = card.querySelector('a.cta') as HTMLAnchorElement;
    expect(back?.textContent).toContain('Try a different address');
    expect(back?.getAttribute('href')).toBe('/');
    TestBed.resetTestingModule();
  });

  it('falls back to the generic explanation when the detail is unrecognized', async () => {
    const { fixture } = await setupFailure('something the UI has never seen', false);
    const card = fixture.nativeElement.querySelector('.error-card') as HTMLElement;
    expect(card.textContent).toContain('We can’t price this property yet');
    expect(card.textContent).toContain('outside the range our cost data covers');
    expect(card.textContent).not.toContain('something the UI has never seen');
    expect(card.querySelector('button')).toBeNull();
    TestBed.resetTestingModule();
  });

  it('keeps the retry button for transient (retryable) failures', async () => {
    const { fixture, store } = await setupFailure('Request failed. Please try again.', true);
    expect(store.selectSnapshot(ReportState.error)).toBe('load');
    const card = fixture.nativeElement.querySelector('.error-card') as HTMLElement;
    expect(card.textContent).toContain('We could not load your report.');
    const retry = card.querySelector('button.cta') as HTMLButtonElement;
    expect(retry?.textContent).toContain('Try again');
    TestBed.resetTestingModule();
  });
});
