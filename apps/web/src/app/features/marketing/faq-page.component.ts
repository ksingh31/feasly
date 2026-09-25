import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';

/**
 * FAQ (SEO-010): prerendered marketing page with FAQPage JSON-LD.
 *
 * Questions/answers come from `copy.marketing.faq` (config-owned, so the
 * no-hardcode tripwire stays green). The accordion is progressively
 * enhanced: answers render in the DOM for crawlers and no-JS readers, and
 * the toggle only controls visibility. JSON-LD mirrors the visible items
 * exactly (validator-checked in the build-output test).
 */
@Component({
  selector: 'app-faq-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './faq-page.component.html',
  styleUrl: './marketing.scss',
})
export class FaqPageComponent implements OnInit {
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  /** FAQ copy (config-owned). */
  readonly copy = this.config.get('copy').marketing.faq;

  /** Index of the open accordion item; -1 collapses all. No leaked state: a plain signal. */
  readonly openIndex = signal(-1);

  ngOnInit(): void {
    this.seo.setForRoute('faq');
    this.seo.setJsonLd({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: this.copy.items.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    });
  }

  toggle(index: number): void {
    this.openIndex.update((current) => (current === index ? -1 : index));
  }
}
