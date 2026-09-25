import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { ChooseProjectType, type ProjectType } from '../wizard/wizard.actions';

/**
 * How it works (SEO-010): prerendered marketing page.
 *
 * The 4-step flow (address → scope → preview → unlock), the
 * deterministic-math note, and CTAs that preselect the project type in NGXS
 * before entering the wizard at the address step (`/`). The scope step reads
 * the preselected type and shows it as already chosen.
 * All user-facing copy comes from ConfigService (no-hardcode tripwire).
 */
@Component({
  selector: 'app-how-it-works-page',
  standalone: true,
  imports: [SiteFooterComponent, SiteNavComponent],
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
    this.seo.setJsonLd(null);
  }

  /**
   * CTA: preselect the project type in NGXS, then enter the wizard at the
   * address step (`/`). The scope step reads the preselected type and shows
   * it as already chosen.
   */
  startEstimate(type: ProjectType): void {
    this.store.dispatch(new ChooseProjectType(type));
    void this.router.navigate(['/']);
  }
}
