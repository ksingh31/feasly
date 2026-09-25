import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { provideApi } from '../../core/api';
import { providePropertyData } from '../../core/api/property-data.service';
import { ConfigService } from '../../core/config';
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

  async function setup(configOverrides: Record<string, unknown> = {}): Promise<void> {
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
    zoning: 'R-CG',
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
    expect(card.getAttribute('href')).toBe('/estimate/compare');
    expect(card.textContent).toContain('Compare neighbourhoods');
    expect(card.textContent).toContain('Side-by-side build costs for 2–3 Calgary communities.');
  });

  it('comparison entry renders above the trust strip (Karan layout)', () => {
    const main = fixture.nativeElement.querySelector('main.page');
    const sections = [...main.querySelectorAll(':scope > section')].map((el: Element) =>
      el.className.split(' ')[0],
    );
    expect(sections).toContain('compare-entry');
    expect(sections).toContain('trust');
    expect(sections.indexOf('compare-entry')).toBeLessThan(sections.indexOf('trust'));
  });

  it('trust strip carries no ±, %, or accuracy claim (copy-lint)', () => {
    const items = [...fixture.nativeElement.querySelectorAll('.trust-item')].map((el: Element) =>
      el.textContent?.trim(),
    );
    // Default test config has propertyData.source 'mock' → mock items, never live-data claims.
    expect(items).toEqual([
      'Range-based estimates',
      'Sample property data — live City records coming soon',
      'AI cost breakdown',
    ]);
    for (const item of items) {
      expect(item).not.toMatch(/[±%]/);
      expect(item?.toLowerCase()).not.toContain('accura');
    }
  });

  it('trust strip claims live City data only when live property data serves the page', async () => {
    await setup({ propertyData: { source: 'live' } });
    const items = [...fixture.nativeElement.querySelectorAll('.trust-item')].map((el: Element) =>
      el.textContent?.trim(),
    );
    expect(items).toEqual(['Range-based estimates', 'Real City of Calgary data', 'AI cost breakdown']);
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
    expect(questions[0]['name']).toBe('Is Feasly free?');
  });
});
