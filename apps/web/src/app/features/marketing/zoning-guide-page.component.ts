import { Component, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { buildArticleSchema, buildFaqPageSchema } from '../../core/seo/jsonld-schemas';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { ResetWizard } from '../wizard/wizard.actions';

/**
 * Zoning explainer (SEO guides): long-form "Calgary zoning explained"
 * guide at `/guides/calgary-zoning-explained`.
 *
 * Plain-language tour of Calgary land use designations (R-C1, R-C2, R-CG,
 * R-G, H-GO, multi-residential, commercial, industrial, Direct Control)
 * with the key "can I build a single-family home here?" table, how to look
 * up a parcel's zoning, and a short FAQ — including why the estimator only
 * quotes single-family homes. Funnels into the estimator and links to the
 * build-cost pillar guide.
 *
 * Article + FAQPage JSON-LD mirror the visible copy exactly (same config
 * source — schema and visible copy can't drift). All user-facing copy comes
 * from ConfigService (no-hardcode tripwire). Zone facts follow the City of
 * Calgary Land Use Bylaw 1P2007.
 */
@Component({
  selector: 'app-zoning-guide-page',
  standalone: true,
  imports: [SiteFooterComponent, SiteNavComponent, RouterLink],
  templateUrl: './zoning-guide-page.component.html',
  styleUrl: './marketing.scss',
})
export class ZoningGuidePageComponent implements OnInit {
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly store = inject(Store);
  private readonly router = inject(Router);

  /** Zoning-guide copy (config-owned). */
  readonly copy = this.config.get('copy').marketing.zoningGuide;

  /** Index of the open FAQ accordion item; -1 collapses all. No leaked state: a plain signal. */
  readonly openIndex = signal(-1);

  ngOnInit(): void {
    this.seo.setForRoute('guides/calgary-zoning-explained');
    // SEO: Article + FAQPage schemas mirror the rendered copy exactly
    // (same config source — schema and visible copy can't drift).
    const siteUrl = this.seo.getSiteUrl();
    const pageUrl = `${siteUrl}/guides/calgary-zoning-explained/`;
    const seoCopy = this.config.get('copy').seo;
    const article = buildArticleSchema(siteUrl, pageUrl, this.copy.title, seoCopy.zoningGuide);
    const faqPage = buildFaqPageSchema(this.copy.faqs);
    this.seo.setJsonLd({
      '@context': 'https://schema.org',
      '@graph': [article, faqPage].map((s) => {
        const { '@context': _ctx, ...rest } = s;
        return rest;
      }),
    });
  }

  toggle(index: number): void {
    this.openIndex.update((current) => (current === index ? -1 : index));
  }

  /**
   * CTA: reset any stale wizard state, then enter the wizard at the
   * address step (`/`). The user picks the project type on the scope step.
   */
  startEstimate(): void {
    this.store.dispatch(new ResetWizard());
    void this.router.navigate(['/']);
  }
}
