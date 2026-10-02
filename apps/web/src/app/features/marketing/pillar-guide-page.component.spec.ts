import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config';
import { WizardState } from '../wizard/wizard.state';
import { PillarGuidePageComponent } from './pillar-guide-page.component';

/**
 * SEO pillar: /guides/cost-to-build-a-house-calgary renders the full
 * guide from config, toggles the FAQ accordion, injects Article + FAQPage
 * JSON-LD mirroring the visible copy — and stays indexable.
 */
describe('PillarGuidePageComponent', () => {
  let fixture: ComponentFixture<PillarGuidePageComponent>;
  let httpMock: HttpTestingController;

  const faqs = [
    { q: 'How much does it cost to build a house in Calgary?', a: 'Budget roughly $1.2M–$2.1M all-in.' },
    { q: 'What drives the cost up or down the most?', a: 'Land value, size, and finish tier.' },
    { q: 'Is land included in the estimate?', a: 'Yes — assessed land value is added.' },
    { q: 'Are these numbers quotes?', a: 'No — planning ranges.' },
  ];
  const baseConfig = {
    site: { url: 'https://feasly.com', name: 'Feasly', socialImage: '/assets/og/og-default.png' },
    copy: {
      seo: {
        pillarGuideTitle: 'Feasly — How much does it cost to build a house in Calgary?',
        pillarGuide: 'Planning ranges for building a house in Calgary.',
      },
      marketing: {
        pillarGuide: {
          eyebrow: 'Calgary build-cost guide',
          title: 'How much does it cost to build a house in Calgary?',
          lede: 'For a typical 2,400 sq ft new build, most Calgary projects budget roughly $1.2M–$2.1M all-in.',
          tiersTitle: 'Cost per square foot by finish tier',
          tiersIntro: 'Build cost before land, from our current cost model.',
          tiers: [
            { name: 'Standard', range: '$195–$293 per sq ft', blurb: 'Practical, durable finishes.' },
            { name: 'Premium', range: '$262–$391 per sq ft', blurb: 'Upgraded selections.' },
            { name: 'Luxury', range: '$360–$541 per sq ft', blurb: 'High-end specifications.' },
          ],
          exampleTitle: 'What that looks like for a 2,400 sq ft home',
          exampleBody: 'The build itself budgets roughly $468,000–$703,000 at Standard tier.',
          includedTitle: 'What’s included in the estimate',
          includedBody: '60+ line items covering structure, envelope, and finishes.',
          excludedTitle: 'What’s not included',
          excludedBody: 'Only landscaping.',
          infillTitle: 'Infill vs greenfield',
          infillBody: 'The land line is what moves.',
          financingTitle: 'How people usually pay for a build',
          financingBody: 'Most custom builds use a construction loan.',
          faqTitle: 'Common questions',
          faqs,
          mathNoteTitle: 'Real math, not guesses',
          mathNoteBody: 'Figures are planning ranges, not quotes.',
          ctaEstimate: 'Get my free estimate →',
          ctaCommunities: 'Browse community cost guides',
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
      imports: [PillarGuidePageComponent],
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
    fixture = TestBed.createComponent(PillarGuidePageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('renders the guide sections and tier table from config', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('How much does it cost to build a house in Calgary?');
    expect(text).toContain('$195–$293 per sq ft');
    expect(text).toContain('$262–$391 per sq ft');
    expect(text).toContain('$360–$541 per sq ft');
    expect(text).toContain('Infill vs greenfield');
    expect(text).toContain('How people usually pay for a build');
  });

  it('sets the document title from the SEO route', () => {
    expect(TestBed.inject(Title).getTitle()).toBe(
      'Feasly — How much does it cost to build a house in Calgary?',
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
    expect(article?.headline).toBe('How much does it cost to build a house in Calgary?');
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
