import { Component, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';

/**
 * How it works (SEO-010): prerendered marketing page.
 *
 * The 4-step flow (address → scope → preview → unlock), the
 * deterministic-math note, and CTAs to the single wizard entry (`/`).
 * Both project types enter through the address step — the scope step is
 * where new build vs renovation is chosen, so both CTAs route there rather
 * than touching wizard state (no preselect hacks, no stale persistence).
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

  /** How-it-works copy (config-owned). */
  readonly copy = this.config.get('copy').marketing.howItWorks;

  ngOnInit(): void {
    this.seo.setForRoute('how-it-works');
    this.seo.setJsonLd(null);
  }
}
