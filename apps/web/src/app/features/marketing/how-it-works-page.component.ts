import { Component, inject, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { LoadPartners, PartnersState } from '../../core/partners';
import { buildHowToSchema } from '../../core/seo/jsonld-schemas';
import { EstimateScopeComponent, SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { ChooseProjectType, type ProjectType } from '../wizard/wizard.actions';

/**
 * How it works (SEO-010): prerendered marketing page.
 *
 * The 4-step flow (address → scope → preview → unlock), the
 * deterministic-math note, and CTAs into the estimator. Both project-type
 * CTAs preselect the type in NGXS before entering the wizard at the address
 * step (`/`); the scope step reads the preselected type and shows it as
 * already chosen. Renovation estimates are out of launch scope, so a
 * preselected renovation flows through the scope step's Continue into the
 * reno scope-inputs step and ends at the designed "coming soon" page
 * (never a dead end, never a guard bounce).
 * All user-facing copy comes from ConfigService (no-hardcode tripwire).
 */
@Component({
  selector: 'app-how-it-works-page',
  standalone: true,
  imports: [EstimateScopeComponent, RouterLink, SiteFooterComponent, SiteNavComponent],
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

  /**
   * #918: builder partners section — the same `PartnersState` the lead
   * capture points read (one request per session; browser-only, so the
   * prerendered page carries the heading + intro and the list hydrates).
   */
  protected readonly partnersCopy = this.config.get('copy').partners;
  protected readonly partners = this.store.selectSignal(PartnersState.partners);
  protected readonly partnersStatus = this.store.selectSignal(PartnersState.status);

  ngOnInit(): void {
    this.seo.setForRoute('how-it-works');
    this.store.dispatch(new LoadPartners());
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
   * Project-type CTAs: preselect the type in NGXS, then enter the wizard at
   * the address step (`/`). The scope step reads the preselected type and
   * shows it as already chosen.
   *
   * Renovation: renovation estimates are out of launch scope, so a
   * preselected renovation routes through the scope step's Continue into
   * the reno scope-inputs step and lands on the designed "coming soon"
   * page — a designed page, never a spinner or a generic error. Routing
   * via `/` like the new-build CTA keeps `wizardPropertyGuard` from
   * bouncing fresh visitors: the old direct
   * `/estimate/reno-coming-soon` deep link bounced them to `/` and the
   * button appeared dead.
   */
  startEstimate(type: ProjectType): void {
    this.store.dispatch(new ChooseProjectType(type));
    void this.router.navigate(['/']);
  }
}
