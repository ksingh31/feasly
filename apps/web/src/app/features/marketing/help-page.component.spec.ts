import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import type { HelpAnswerSource } from '../../core/config/app-config';
import { DEFAULT_HELP_COPY } from './help-copy.defaults';
import { HelpPageComponent } from './help-page.component';
import { DEFAULT_ZONING_GUIDE_COPY } from '../../core/config/zoning-guide-copy.defaults';
import { DEFAULT_PILLAR_GUIDE_COPY } from './pillar-guide-copy.defaults';

/**
 * #834: /help groups reused FAQ answers by topic, filters them client-side
 * (no API call), links to How we estimate + status, and routes callbacks
 * through the report.
 */
describe('HelpPageComponent', () => {
  let fixture: ComponentFixture<HelpPageComponent>;
  let httpMock: HttpTestingController;

  async function setup(served: Record<string, unknown> = {}): Promise<void> {
    TestBed.resetTestingModule();
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => s.remove());
    TestBed.configureTestingModule({
      imports: [HelpPageComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush(served);
    await pending;
    fixture = TestBed.createComponent(HelpPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const questions = (): string[] =>
    [...el().querySelectorAll('.help-topic .help-q')].map((h) => h.textContent?.trim() ?? '');

  function search(value: string): void {
    const input = el().querySelector('#help-search-input') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  beforeEach(async () => {
    await setup();
  });

  afterEach(() => {
    // AC1: search never calls the API — only the config load above.
    httpMock.verify();
  });

  it('renders the five topics in order, each with answers', () => {
    const titles = [...el().querySelectorAll('.help-topic-title')].map((h) => h.textContent?.trim());
    expect(titles).toEqual(['Estimates', 'Zoning', 'Assessed value', 'Privacy', 'Builders']);
    for (const topic of fixture.componentInstance.topics) {
      expect(topic.answers.length).toBeGreaterThan(0);
    }
  });

  it('every configured answer reference resolves to a config FAQ entry (no silent drops)', () => {
    const copy = DEFAULT_APP_CONFIG.copy;
    const sources: Record<HelpAnswerSource, readonly { q: string }[]> = {
      faq: copy.marketing.faq.items,
      pillarGuide: DEFAULT_PILLAR_GUIDE_COPY.faqs,
      zoningGuide: DEFAULT_ZONING_GUIDE_COPY.faqs,
      communities: copy.communities.faqItems,
    };
    for (const topic of DEFAULT_HELP_COPY.topics) {
      for (const ref of topic.answers) {
        expect(sources[ref.source].some((item) => item.q === ref.q), `${ref.source}: ${ref.q}`).toBe(true);
      }
    }
    const configured = DEFAULT_HELP_COPY.topics.reduce((n, t) => n + t.answers.length, 0);
    expect(questions()).toHaveLength(configured);
  });

  it('reuses the FAQ answer text verbatim', () => {
    const faq = DEFAULT_APP_CONFIG.copy.marketing.faq.items.find((i) => i.q === 'Who sees my information?');
    expect(el().textContent).toContain(faq?.a);
  });

  it('filters answers client-side and announces the count', () => {
    search('zoning');
    const shown = questions();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(fixture.componentInstance.topics.flatMap((t) => t.answers).length);
    expect(el().querySelector('#help-search-results')?.textContent?.trim()).toBe(
      `${shown.length} answers match your search.`,
    );
  });

  it('matches every word, case-insensitively, across question and answer', () => {
    search('MAGIC   link');
    expect(questions()).toEqual(['How does the magic link work?']);
    expect(el().querySelector('#help-search-results')?.textContent?.trim()).toBe('1 answer matches your search.');
    // A topic with no match drops out entirely.
    const titles = [...el().querySelectorAll('.help-topic-title')].map((h) => h.textContent?.trim());
    expect(titles).toEqual(['Privacy']);
  });

  it('shows the no-results message, and clear restores every answer', () => {
    search('xyzzy-nothing');
    expect(questions()).toEqual([]);
    expect(el().querySelector('#help-search-results')?.textContent).toContain('No answers match your search.');
    (el().querySelector('.help-search-clear') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(questions().length).toBe(fixture.componentInstance.topics.flatMap((t) => t.answers).length);
    expect(el().querySelector('#help-search-results')?.textContent?.trim()).toBe('');
    expect(document.activeElement?.id).toBe('help-search-input');
  });

  it('links to How we estimate and the FAQ; hides the status link while unconfigured', () => {
    const hrefs = [...el().querySelectorAll('.hwe-links a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/how-it-works', '/faq']);
  });

  it('links to the status page when configured', async () => {
    await setup({ site: { statusPageUrl: 'https://status.example.test/' } });
    const link = el().querySelector('.hwe-links a[href="https://status.example.test/"]');
    expect(link?.textContent?.trim()).toBe('Service status');
  });

  it('contact: request-a-callback routes to the report or a new estimate', () => {
    const contact = el().querySelector('.help-contact') as HTMLElement;
    expect(contact.querySelector('h2')?.textContent?.trim()).toBe('Contact us');
    expect(contact.textContent).toContain('Request a callback');
    const hrefs = [...contact.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/my-report', '/']);
  });

  it('has exactly one h1 and sets indexable SEO + WebPage JSON-LD mirroring the h1', () => {
    expect(el().querySelectorAll('h1')).toHaveLength(1);
    expect(document.title).toBe('Help and contact · Feasly');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? '').not.toContain('noindex');
    const script = document.querySelector('script[type="application/ld+json"]');
    const data = JSON.parse(script?.textContent ?? '{}') as Record<string, unknown>;
    expect(data['@type']).toBe('WebPage');
    expect(data['name']).toBe(el().querySelector('h1')?.textContent?.trim());
    expect(String(data['url'])).toMatch(/\/help\/$/);
  });
  it('merges deploy-time copy.marketing.help overrides over the lazy defaults', async () => {
    await setup({ copy: { marketing: { help: { title: 'Get help' } } } });
    expect(el().querySelector('h1')?.textContent?.trim()).toBe('Get help');
    expect(el().querySelector('.help-contact h2')?.textContent?.trim()).toBe('Contact us');
  });

  it('drops a topic whose every reference misses (no empty section)', async () => {
    await setup({
      copy: {
        marketing: {
          help: {
            topics: [
              { id: 'gone', title: 'Gone', answers: [{ source: 'faq', q: 'No such question?' }] },
              ...DEFAULT_HELP_COPY.topics,
            ],
          },
        },
      },
    });
    const titles = [...el().querySelectorAll('.help-topic-title')].map((h) => h.textContent?.trim());
    expect(titles).toEqual(['Estimates', 'Zoning', 'Assessed value', 'Privacy', 'Builders']);
  });
});
