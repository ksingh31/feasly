import { Component, inject, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { buildHowToSchema } from '../../core/seo/jsonld-schemas';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { ChooseProjectType, type ProjectType } from '../wizard/wizard.actions';

/**
 * How it works (SEO-010): prerendered marketing page.
 *
 * The 4-step flow (address → scope → preview → unlock), the
 * deterministic-math note, and CTAs into the estimator. The new-build CTA
 * preselects the project type in NGXS before entering the wizard at the
 * address step (`/`); the scope step reads the preselected type and shows
 * it as already chosen. Renovation estimates are out of launch scope, so
 * the renovation CTA lands on the designed "coming soon" page instead of
 * preselecting a type the wizard can't price.
 * All user-facing copy comes from ConfigService (no-hardcode tripwire).
 */
@Component({
  selector: 'app-how-it-works-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './how-it-works-page.component.html',
  styleUrl: './marketing.scss',
})
export class HowItWorksPageComponent implements OnInit {
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly store = inject(Store);
  private readonly router = inject(Router);

  /** How-it-works copy (config-owned). */
  readonly copy = this.config.get('copy').marketing.howItWorks;

  ngOnInit(): void {
    this.seo.setForRoute('how-it-works');
    // SEO: HowTo schema mirrors the rendered 4 steps (same config copy —
    // schema and visible copy can't drift).
    const siteUrl = this.seo.getSiteUrl();
    this.seo.setJsonLd(
      buildHowToSchema(
        `${siteUrl}/how-it-works/`,
        this.copy.title,
        this.copy.sub,
        this.copy.steps,
      ),
    );
  }

  /**
   * New-build CTA: preselect the project type in NGXS, then enter the
   * wizard at the address step (`/`). The scope step reads the preselected
   * type and shows it as already chosen.
   *
   * Renovation CTA: renovation estimates are out of launch scope — land on
   * the designed "coming soon" page (never the home page with a renovation
   * preselect the wizard can't price).
   */
  startEstimate(type: ProjectType): void {
    if (type === 'renovation') {
      void this.router.navigate(['/estimate/reno-coming-soon']);
      return;
    }
    this.store.dispatch(new ChooseProjectType(type));
    void this.router.navigate(['/']);
  }
}
