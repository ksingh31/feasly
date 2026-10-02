import { Component, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { buildArticleSchema, buildFaqPageSchema } from '../../core/seo/jsonld-schemas';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { ResetWizard } from '../wizard/wizard.actions';

/**
 * Pillar guide (SEO pillar): long-form "cost to build a house in Calgary"
 * guide at `/guides/cost-to-build-a-house-calgary`.
 *
 * Owns the head keyword with cost-per-sq-ft bands by finish tier (figures
 * from the repo cost model — planning ranges, never accuracy claims),
 * inclusions/exclusions, infill vs greenfield, financing basics, and a
 * short FAQ. Links down to `/communities/` pages and funnels into the
 * estimator. Article + FAQPage JSON-LD mirror the visible copy exactly.
 * All user-facing copy comes from ConfigService (no-hardcode tripwire).
 */
@Component({
  selector: 'app-pillar-guide-page',
  standalone: true,
  imports: [SiteFooterComponent, SiteNavComponent, RouterLink],
  templateUrl: './pillar-guide-page.component.html',
  styleUrl: './marketing.scss',
})
export class PillarGuidePageComponent implements OnInit {
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly store = inject(Store);
  private readonly router = inject(Router);

  /** Pillar-guide copy (config-owned). */
  readonly copy = this.config.get('copy').marketing.pillarGuide;

  /** Index of the open FAQ accordion item; -1 collapses all. No leaked state: a plain signal. */
  readonly openIndex = signal(-1);

  ngOnInit(): void {
    this.seo.setForRoute('guides/cost-to-build-a-house-calgary');
    // SEO: Article + FAQPage schemas mirror the rendered copy exactly
    // (same config source — schema and visible copy can't drift).
    const siteUrl = this.seo.getSiteUrl();
    const pageUrl = `${siteUrl}/guides/cost-to-build-a-house-calgary/`;
    const seoCopy = this.config.get('copy').seo;
    const article = buildArticleSchema(
      siteUrl,
      pageUrl,
      this.copy.title,
      seoCopy.pillarGuide,
      this.seo.getSocialImageUrl(),
    );
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
