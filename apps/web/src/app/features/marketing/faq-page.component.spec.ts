import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config';
import { FaqPageComponent } from './faq-page.component';

/**
 * SEO-010: /faq renders every question/answer from config, toggles the
 * accordion, injects matching FAQPage JSON-LD — and stays indexable.
 */
describe('FaqPageComponent', () => {
  let fixture: ComponentFixture<FaqPageComponent>;
  let httpMock: HttpTestingController;

  const items = [
    { q: 'Is Feasly free?', a: 'There is no charge.' },
    { q: 'How does the magic link work?', a: 'It expires after 7 days.' },
  ];
  const baseConfig = {
    site: { url: 'https://feasly.com', name: 'Feasly', socialImage: '/assets/og/og-default.png' },
    copy: {
      seo: { faqTitle: 'Feasly — FAQ', faq: 'FAQ description.' },
      marketing: {
        faq: {
          eyebrow: 'FAQ',
          title: 'Frequently asked questions',
          sub: 'Sub copy.',
          items,
        },
      },
    },
  };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FaqPageComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush(baseConfig);
    await pending;
    fixture = TestBed.createComponent(FaqPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('renders every question and answer in the DOM (crawler-visible)', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    for (const item of items) {
      expect(text).toContain(item.q);
      expect(text).toContain(item.a);
    }
  });

  it('toggles the accordion on click', () => {
    const component = fixture.componentInstance;
    expect(component.openIndex()).toBe(-1);
    component.toggle(0);
    expect(component.openIndex()).toBe(0);
    component.toggle(0);
    expect(component.openIndex()).toBe(-1);
  });

  it('injects FAQPage JSON-LD matching the visible items', () => {
    const script = document.querySelector('script[type="application/ld+json"]');
    expect(script?.textContent).toBeTruthy();
    const data = JSON.parse(script?.textContent ?? '{}') as {
      '@type': string;
      mainEntity: { name: string }[];
    };
    expect(data['@type']).toBe('FAQPage');
    expect(data.mainEntity.map((e) => e.name)).toEqual(items.map((i) => i.q));
  });

  it('stays indexable: no robots noindex tag', () => {
    expect(TestBed.inject(Meta).getTag('name="robots"')).toBeNull();
  });
});
