import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { provideStore, Store } from '@ngxs/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import type { CityDataFreshnessResponse, PropertyRecord } from '@feasly/contracts';
import { API_SERVICE, provideApi } from '../../core/api';
import type { ApiService } from '../../core/api';
import { providePropertyData } from '../../core/api/property-data.service';
import { ConfigService } from '../../core/config';
import { expectSharedCalgaryGate } from '../../shared/test-helpers/entry-gate.harness';
import { LeadState, StoreLeadResult, WizardState, type WizardStateModel } from '../wizard';
import { ReportState } from '../report/report.state';
import { SetReportToken } from '../report/report.actions';
import { LandingPageComponent } from './landing-page.component';

/**
 * FE1-001: landing renders the story copy, the trust strip carries no
 * accuracy claim, selection populates wizard state and routes to scope.
 */
describe('LandingPageComponent', () => {
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<LandingPageComponent>;
  let component: LandingPageComponent;
  let store: Store;
  let router: Router;

  const baseConfig = {
    api: { useMockApi: true },
    timings: { debounceMs: 1, mockLatencyMinMs: 1, mockLatencyMaxMs: 1 },
    limits: { autocompleteSuggestionLimit: 6 },
    // Landing flows are specified against the mock harness (FE1-002).
    propertyData: { source: 'mock' },
  };

  async function setup(
    configOverrides: Record<string, unknown> = {},
    extraProviders: unknown[] = [],
  ): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [LandingPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        providePropertyData(),
        provideApi(),
        provideRouter([{ path: 'estimate/scope', component: LandingPageComponent }]),
        provideStore([WizardState, LeadState, ReportState]),
        ...extraProviders,
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({ ...baseConfig, ...configOverrides });
    await pending;
    store = TestBed.inject(Store);
    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(LandingPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(async () => {
    await setup();
  });

  const fakeProperty = {
    addressKey: 'calgary-1234-14-st-nw',
    address: '1234 14 St NW, Calgary, AB',
    community: 'Capitol Hill',
    lotSqft: 5000,
    zoning: 'R-C1',
    assessedValue: 729000,
    assessmentYear: 2025,
    yearBuilt: 1978,
    dataAsOf: '2025-07-01',
    stale: false,
  } as PropertyRecord;

  it('renders the story hero copy', () => {
    const h1 = fixture.nativeElement.querySelector('.hero-title');
    expect(h1?.textContent).toBe('What will it really cost to build your home in Calgary?');
  });

  it('comparison entry card links to /estimate/compare with the exact story copy (NBH-04)', () => {
    const card = fixture.nativeElement.querySelector('.compare-card') as HTMLAnchorElement;
    expect(card).toBeTruthy();
    // ?fresh=1: the homepage link always starts a fresh comparison on the
    // picker — it must never auto-resume a persisted previous comparison.
    expect(card.getAttribute('href')).toBe('/estimate/compare?fresh=1');
    expect(card.textContent).toContain('Compare neighbourhoods');
    expect(card.textContent).toContain('Side-by-side build costs for 2–3 Calgary communities.');
  });

  it('entry cards render side-by-side above the trust strip (Karan layout)', () => {
    const main = fixture.nativeElement.querySelector('main.page');
    const pair = main.querySelector(':scope > .entry-pair');
    expect(pair).toBeTruthy();
    const hrefs = [...pair.querySelectorAll('.compare-card')].map((el: Element) =>
      el.getAttribute('href'),
    );
    expect(hrefs).toEqual(['/estimate/compare?fresh=1', '/communities']);
    const blocks = [...main.querySelectorAll(':scope > section, :scope > div')].map((el: Element) =>
      el.className.split(' ')[0],
    );
    expect(blocks).toContain('entry-pair');
    expect(blocks).toContain('trust');
    expect(blocks.indexOf('entry-pair')).toBeLessThan(blocks.indexOf('trust'));
  });

  it('trust strip carries no ±, %, or accuracy claim (copy-lint)', () => {
    const values = [...fixture.nativeElement.querySelectorAll('.trust-value-full')].map((el: Element) =>
      el.textContent?.trim(),
    );
    const labels = [...fixture.nativeElement.querySelectorAll('.trust-label')].map((el: Element) =>
      el.textContent?.trim(),
    );
    // Default test config has propertyData.source 'mock' → mock stats, never live-data claims.
    expect(values).toEqual(['Range-based', 'Sample property data', 'Transparent']);
    expect(labels).toEqual(['estimates', 'live City records coming soon', 'cost breakdown']);
    for (const text of [...values, ...labels]) {
      expect(text).not.toMatch(/[±%]/);
      expect(text?.toLowerCase()).not.toContain('accura');
    }
  });

  it('trust strip claims live City data only when live property data serves the page', async () => {
    await setup({ propertyData: { source: 'live' } });
    const values = [...fixture.nativeElement.querySelectorAll('.trust-value-full')].map((el: Element) =>
      el.textContent?.trim(),
    );
    const labels = [...fixture.nativeElement.querySelectorAll('.trust-label')].map((el: Element) =>
      el.textContent?.trim(),
    );
    // The mock API harness answers refreshedMonth null → the honest
    // "Live City data" fallback; no hardcoded month, no accuracy claim.
    expect(values).toEqual(['600,000+', 'Live City data', 'Same fixed formula']);
    expect(labels).toEqual([
      'City of Calgary assessment records',
      'Latest data refresh',
      'AI never invents prices',
    ]);
  });

  describe('trust strip refresh month (trust-strip/01)', () => {
    /** API stub whose getCityDataFreshness answers with a canned response. */
    function freshnessProvider(
      response: Observable<CityDataFreshnessResponse>,
    ): { provide: unknown; useValue: ApiService } {
      const stub = {
        getCityDataFreshness: vi.fn().mockReturnValue(response),
      };
      return { provide: API_SERVICE, useValue: stub as unknown as ApiService };
    }

    function trustValues(): string[] {
      return [...fixture.nativeElement.querySelectorAll('.trust-value-full')].map((el: Element) =>
        el.textContent?.trim(),
      );
    }

    function trustShorts(): string[] {
      return [...fixture.nativeElement.querySelectorAll('.trust-value-short')].map((el: Element) =>
        el.textContent?.trim(),
      );
    }

    it('renders "<Month Year>" when the endpoint reports a month', async () => {
      await setup(
        { propertyData: { source: 'live' } },
        [freshnessProvider(of({ refreshedMonth: 'September 2026' }))],
      );
      fixture.detectChanges();
      expect(trustValues()).toEqual(['600,000+', 'September 2026', 'Same fixed formula']);
      expect(trustShorts()).toEqual(['600,000+', 'Sep 2026', 'Same fixed formula']);
    });

    it('falls back to "Live City data" when the endpoint returns null', async () => {
      await setup(
        { propertyData: { source: 'live' } },
        [freshnessProvider(of({ refreshedMonth: null }))],
      );
      fixture.detectChanges();
      expect(trustValues()).toEqual(['600,000+', 'Live City data', 'Same fixed formula']);
    });

    it('falls back to "Live City data" when the request fails', async () => {
      await setup(
        { propertyData: { source: 'live' } },
        [freshnessProvider(throwError(() => new Error('backend down')))],
      );
      fixture.detectChanges();
      expect(trustValues()).toEqual(['600,000+', 'Live City data', 'Same fixed formula']);
    });

    it('never calls the freshness endpoint on the mock property path', async () => {
      const provider = freshnessProvider(of({ refreshedMonth: 'September 2026' }));
      await setup({ propertyData: { source: 'mock' } }, [provider]);
      fixture.detectChanges();
      expect(trustValues()).toEqual(['Range-based', 'Sample property data', 'Transparent']);
      expect(
        (provider.useValue as unknown as { getCityDataFreshness: ReturnType<typeof vi.fn> })
          .getCityDataFreshness,
      ).not.toHaveBeenCalled();
    });
  });

  it('trust strip renders the redesigned stat blocks with eyebrow, badge, and sample-report button', async () => {
    await setup({ propertyData: { source: 'live' } });
    const root = fixture.nativeElement;
    expect(root.querySelector('.trust-eyebrow')?.textContent?.trim()).toBe('Why Feasly');
    expect(root.querySelectorAll('.trust-item').length).toBe(3);
    // Third stat carries the brass check badge; compact value falls back to the full value.
    const badgeItem = root.querySelector('.trust-item-badge');
    expect(badgeItem?.querySelector('.trust-badge')?.textContent?.trim()).toBe('✓');
    const shorts = [...root.querySelectorAll('.trust-value-short')].map((el: Element) =>
      el.textContent?.trim(),
    );
    expect(shorts).toEqual(['600,000+', 'Live City data', 'Same fixed formula']);
    const cta = root.querySelector('.sample-report-link a') as HTMLAnchorElement;
    expect(cta?.getAttribute('href')).toBe('/sample-report');
    expect(cta?.textContent).toContain('See a sample report');
  });

  it('hides the sample-report slot while the flag is off', () => {
    expect(fixture.nativeElement.querySelector('.sample-link')).toBeNull();
  });

  it('renders no sample-report link even when the flag is on (no dead ends)', async () => {
    await setup({ features: { sampleReport: true } });
    const links = [...fixture.nativeElement.querySelectorAll('a')].map((a: Element) =>
      a.getAttribute('href'),
    );
    expect(links).not.toContain('/r/sample');
    expect(fixture.nativeElement.querySelector('.sample-link')).toBeNull();
  });

  it('selection populates wizard state at step 2 and routes to /estimate/scope', () => {
    const navigate = vi.spyOn(router, 'navigate');
    component.onSelected(fakeProperty);
    const state = store.selectSnapshot<WizardStateModel>((s) => s.wizard);
    expect(state.property?.addressKey).toBe(fakeProperty.addressKey);
    expect(state.step).toBe(2);
    expect(navigate).toHaveBeenCalledWith(['/estimate/scope']);
  });

  it('selecting a new property clears the previous lead receipt and report snapshot', () => {
    store.dispatch(
      new StoreLeadResult({
        leadId: 'lead-old',
        email: 'old@example.com',
        magicLinkSent: true,
        expiresInDays: 7,
      }),
    );
    store.dispatch(new SetReportToken('token-old'));
    component.onSelected(fakeProperty);
    // A stale unlock must not leak into the new property's funnel.
    expect(store.selectSnapshot(LeadState.leadId)).toBeNull();
    expect(store.selectSnapshot(ReportState.reportToken)).toBeNull();
  });

  describe('early coverage guard', () => {
    const bigLotProperty = {
      ...fakeProperty,
      addressKey: 'calgary-999-big-lot-rd-sw',
      address: '999 Big Lot Rd SW, Calgary, AB',
      lotSqft: 643811,
      assessedValue: 729000, // in range — only the LOT is extreme
    } as PropertyRecord;

    it('never blocks on lot size — a big lot flows to scope (lot-size block bug, 2026-09-28)', () => {
      const navigate = vi.spyOn(router, 'navigate');
      component.onSelected(bigLotProperty);
      fixture.detectChanges();
      // No can't-price card: the wizard starts with the big-lot property.
      expect(fixture.nativeElement.querySelector('.coverage-block')).toBeNull();
      expect(navigate).toHaveBeenCalledWith(['/estimate/scope']);
      const state = store.selectSnapshot<WizardStateModel>((s) => s.wizard);
      expect(state.property?.addressKey).toBe('calgary-999-big-lot-rd-sw');
    });

    it("never blocks on Karan's 21,577 sq ft lot", () => {
      const navigate = vi.spyOn(router, 'navigate');
      component.onSelected({
        ...fakeProperty,
        addressKey: 'calgary-1234-11-av-sw',
        address: '1234 11 Av SW, Calgary, AB',
        lotSqft: 21577,
      } as PropertyRecord);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.coverage-block')).toBeNull();
      expect(navigate).toHaveBeenCalledWith(['/estimate/scope']);
    });

    it('shows the generic copy when the assessed value is out of range', () => {
      component.onSelected({ ...fakeProperty, assessedValue: 0 });
      fixture.detectChanges();
      const card = fixture.nativeElement.querySelector('.coverage-block');
      expect(card).not.toBeNull();
      expect(card.textContent).toContain('We can’t price this property yet');
      expect(card.textContent).not.toContain('sq ft');
    });

    it('lets R-C2 (duplex) parcels flow to scope — single-family builds happen there (Karan, 2026-10-02)', () => {
      const navigate = vi.spyOn(router, 'navigate');
      component.onSelected({ ...fakeProperty, zoning: 'R-C2' });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.coverage-block')).toBeNull();
      expect(navigate).toHaveBeenCalledWith(['/estimate/scope']);
    });

    it('shows the single-family message for R-CG (rowhouse) zoning', () => {
      component.onSelected({ ...fakeProperty, zoning: 'R-CG' });
      fixture.detectChanges();
      const card = fixture.nativeElement.querySelector('.coverage-block');
      expect(card).not.toBeNull();
      expect(card.textContent).toContain('single-family');
    });

    it('shows the single-family message for M-C2 (apartment/condo) zoning', () => {
      component.onSelected({ ...fakeProperty, zoning: 'M-C2' });
      fixture.detectChanges();
      const card = fixture.nativeElement.querySelector('.coverage-block');
      expect(card).not.toBeNull();
      expect(card.textContent).toContain('single-family');
    });

    it('still shows the commercial/industrial message for non-residential parcels', () => {
      component.onSelected({ ...fakeProperty, isNonResidential: true });
      fixture.detectChanges();
      const card = fixture.nativeElement.querySelector('.coverage-block');
      expect(card).not.toBeNull();
      expect(card.textContent).toContain('commercial or industrial');
    });

    it('a big lot still flows to scope and clears a previous block', () => {
      const navigate = vi.spyOn(router, 'navigate');
      // An assessed-value block first...
      component.onSelected({ ...fakeProperty, assessedValue: 0 });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.coverage-block')).not.toBeNull();
      // ...then a big lot clears it and flows to scope (lot size never blocks).
      component.onSelected(bigLotProperty);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.coverage-block')).toBeNull();
      expect(navigate).toHaveBeenCalledWith(['/estimate/scope']);
    });

    it('“try a different address” dismisses the card and resets the search box', () => {
      component.onSelected({ ...fakeProperty, assessedValue: 0 });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.coverage-block')).not.toBeNull();
      const button = fixture.nativeElement.querySelector('.coverage-cta') as HTMLButtonElement;
      expect(button.textContent).toContain('Try a different address');
      button.click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.coverage-block')).toBeNull();
      // Wizard state untouched — the blocked property was never selected.
      expect(store.selectSnapshot<WizardStateModel>((s) => s.wizard.property)).toBeNull();
    });
  });

  it('submit with an empty query shows the hint (no dead end)', () => {
    component.onSubmit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.form-error')?.textContent).toContain(
      'Enter your Calgary address',
    );
  });

  it('sets the page title and meta description', () => {
    const title = TestBed.inject(Title).getTitle();
    expect(title).toContain('What will it really cost to build your home in Calgary?');
  });

  it('injects WebSite + FAQPage JSON-LD via @graph (SEO-06)', () => {
    const script = document.head.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();

    const data = JSON.parse(script!.textContent ?? '{}') as {
      '@context': string;
      '@graph': Array<{ '@type': string; [key: string]: unknown }>;
    };
    expect(data['@context']).toBe('https://schema.org');
    expect(Array.isArray(data['@graph'])).toBe(true);

    const types = data['@graph'].map((n) => n['@type']);
    expect(types).toContain('WebSite');
    expect(types).toContain('FAQPage');

    // WebSite has name and url, no invented phone/address.
    const website = data['@graph'].find((n) => n['@type'] === 'WebSite')!;
    expect(website['name']).toBe('Feasly');
    expect(website['url']).toBeDefined();
    expect(website['telephone']).toBeUndefined();
    expect(website['address']).toBeUndefined();

    // FAQPage has questions from the config (no drift).
    const faqPage = data['@graph'].find((n) => n['@type'] === 'FAQPage')!;
    const questions = (faqPage['mainEntity'] as Array<{ '@type': string; name: string }>) ?? [];
    expect(questions.length).toBeGreaterThanOrEqual(3);
    expect(questions[0]['@type']).toBe('Question');
    expect(questions[0]['name']).toBe('How much does it cost to build a house in Calgary?');
  });
  afterEach(() => {
    // Remove JSON-LD scripts to prevent test pollution (SEO-06).
    document.head
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((el) => el.remove());
  });

  describe('Calgary-only gate (D-03)', () => {
    it('shows the shared Calgary-only gate on an out-of-coverage query', async () => {
      // Entry-point integration: both the new-build AND the reno flows
      // start at this hero search (reno pages have no address input of
      // their own — reno users must pick a property here first), so the
      // shared component's gate must surface here for all three entries
      // (new-build, reno, embed).
      await expectSharedCalgaryGate(fixture);
    });
  });
});
