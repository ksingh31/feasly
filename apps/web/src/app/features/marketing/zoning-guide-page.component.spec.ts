import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config';
import { WizardState } from '../wizard/wizard.state';
import { ZoningGuidePageComponent } from './zoning-guide-page.component';

/**
 * SEO guides: /guides/calgary-zoning-explained renders the full zoning
 * guide from config, toggles the FAQ accordion, injects Article + FAQPage
 * JSON-LD mirroring the visible copy — and stays indexable.
 */
describe('ZoningGuidePageComponent', () => {
  let fixture: ComponentFixture<ZoningGuidePageComponent>;
  let httpMock: HttpTestingController;

  const faqs = [
    { q: 'What does R-C1 mean?', a: "R-C1 is Calgary's classic single-family zone." },
    { q: 'Can I build a duplex on an R-C1 lot?', a: 'No — a duplex is not a permitted use in R-C1.' },
    {
      q: 'Why does Feasly only quote single-family homes?',
      a: 'Our estimator prices single-family new builds.',
      anchor: 'why-single-family-only',
    },
  ];
  const baseConfig = {
    site: { url: 'https://feasly.com', name: 'Feasly', socialImage: '/assets/og/og-default.png' },
    copy: {
      seo: {
        zoningGuideTitle: 'Calgary Zoning Explained: What R-C1, R-C2, R-CG & Other Zones Mean | Feasly',
        zoningGuide: 'What Calgary zoning designations mean.',
      },
      marketing: {
        zoningGuide: {
          eyebrow: 'Calgary zoning guide',
          title: "Calgary zoning explained: what your lot's designation means",
          lede: 'Every parcel in Calgary carries a zoning designation.',
          introTitle: 'What zoning is',
          introBody: 'Zoning is the rulebook tied to a piece of land.',
          tableTitle: 'Can I build a single-family home here?',
          tableIntro: 'The zones you will actually encounter on Calgary land.',
          tableHeaders: {
            zone: 'Zone',
            name: 'Full name',
            allows: 'What it allows',
            build: 'Single-family build?',
          },
          zones: [
            {
              code: 'R-C1',
              name: 'Residential – Contextual Single Detached',
              allows: 'Single-detached homes, plus suites',
              build: 'Yes',
            },
            {
              code: 'R-C2',
              name: 'Residential – Contextual Duplex',
              allows: 'Single-detached, semi-detached and duplex homes',
              build: 'Yes',
            },
            {
              code: 'M-C1 / M-C2',
              name: 'Multi-Residential – Contextual',
              allows: 'Apartment buildings',
              build: 'No',
            },
            {
              code: 'DC',
              name: 'Direct Control',
              allows: 'Site-specific rules approved by Council',
              build: 'Maybe — check the individual DC bylaw',
            },
          ],
          recentTitle: 'Zoning has changed recently in Calgary',
          recentBody: 'In 2024 the City made R-CG the default; in 2026 most lots reverted.',
          lookupTitle: "How to find your property's zoning",
          lookupBody: "Use the City of Calgary's Development Map on calgary.ca.",
          faqTitle: 'Common questions',
          faqs,
          sourceTitle: 'Sources',
          sourceBody: 'Zone definitions follow the City of Calgary Land Use Bylaw 1P2007.',
          sourceLinkLabel: 'Read the Land Use Bylaw on calgary.ca',
          sourceUrl: 'https://www.calgary.ca/planning/land-use/online-land-use-bylaw.html',
          verifyNote: 'Designations can change through rezoning.',
          ctaEstimate: 'Check what your lot can build →',
          ctaCostGuide: 'Read the Calgary build-cost guide',
        },
      },
    },
  };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    document
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((s) => s.remove());
    TestBed.configureTestingModule({
      imports: [ZoningGuidePageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideStore([WizardState]),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush(baseConfig);
    await pending;
    fixture = TestBed.createComponent(ZoningGuidePageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('renders the guide sections and zone table from config', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain("Calgary zoning explained: what your lot's designation means");
    expect(text).toContain('Can I build a single-family home here?');
    expect(text).toContain('R-C1');
    expect(text).toContain('Residential – Contextual Duplex');
    expect(text).toContain('Zoning has changed recently in Calgary');
    expect(text).toContain("How to find your property's zoning");
  });

  it('sets the document title from the SEO route', () => {
    expect(TestBed.inject(Title).getTitle()).toBe(
      'Calgary Zoning Explained: What R-C1, R-C2, R-CG & Other Zones Mean | Feasly',
    );
  });

  it('toggles the FAQ accordion on click', () => {
    const component = fixture.componentInstance;
    expect(component.openIndex()).toBe(-1);
    component.toggle(1);
    expect(component.openIndex()).toBe(1);
    component.toggle(1);
    expect(component.openIndex()).toBe(-1);
  });

  it('exposes the deep-link anchor for the single-family eligibility FAQ', () => {
    const el = (fixture.nativeElement as HTMLElement).querySelector('#why-single-family-only');
    expect(el?.textContent).toContain('Why does Feasly only quote single-family homes?');
  });

  it('injects Article + FAQPage JSON-LD mirroring the visible copy', () => {
    const script = document.querySelector(
      'script[type="application/ld+json"]:not([data-jsonld-id])',
    );
    expect(script?.textContent).toBeTruthy();
    const data = JSON.parse(script?.textContent ?? '{}') as {
      '@graph': { '@type': string; headline?: string; mainEntity?: { name: string }[] }[];
    };
    const types = data['@graph'].map((n) => n['@type']);
    expect(types).toContain('Article');
    expect(types).toContain('FAQPage');
    const article = data['@graph'].find((n) => n['@type'] === 'Article');
    expect(article?.headline).toBe("Calgary zoning explained: what your lot's designation means");
    const faq = data['@graph'].find((n) => n['@type'] === 'FAQPage');
    expect(faq?.mainEntity?.map((e) => e.name)).toEqual(faqs.map((i) => i.q));
  });

  it('stays indexable: no robots noindex tag', () => {
    expect(TestBed.inject(Meta).getTag('name="robots"')).toBeNull();
  });

  afterEach(() => {
    document.head
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((el) => el.remove());
  });
});
