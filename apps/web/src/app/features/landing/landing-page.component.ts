import { Component, inject, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { ClearLead, GoToStep, SelectProperty } from '../wizard';
import { ClearReport } from '../report/report.actions';
import { AddressAutocompleteComponent, SiteFooterComponent, SiteNavComponent } from '../../shared/components';

/**
 * S0 landing (FE1-001): one job — get the address.
 *
 * Visual language locked to the prototype (cream/charcoal/brass; Syne wordmark,
 * Manrope headlines, Instrument Sans UI); hero content follows the story: the address question,
 * autocomplete (3+ chars, config debounce, max 6 suggestions), and selection
 * routes to `/estimate/scope` with wizard state populated at step 2.
 * All user-facing copy comes from ConfigService (no-hardcode tripwire).
 */
@Component({
  selector: 'app-landing-page',
  standalone: true,
  imports: [
    AddressAutocompleteComponent,
    FormsModule,
    RouterLink,
    SiteFooterComponent,
    SiteNavComponent,
  ],
  templateUrl: './landing-page.component.html',
  styleUrl: './landing-page.component.scss',
})
export class LandingPageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  /** Landing + search copy (config-owned). */
  readonly copy = this.config.get('copy').landing;
  readonly searchCopy = this.config.get('copy').search;
  /** Neighbourhood comparison entry copy (NBH-04). */
  readonly compareCopy = this.config.get('copy').comparison;
  /** Community guides entry copy (SEO-05). */
  readonly guidesCopy = this.config.get('copy').marketing.communities;

  /**
   * Trust items with mock-aware substitution: while the mock property
   * harness serves the data, the property-data item must not claim live
   * City data. Keyed off `propertyData.source` (not `api.useMockApi`):
   * the property backend is an independent switch.
   */
  readonly trustItems =
    this.config.get('propertyData').source === 'mock'
      ? this.copy.trustItemsMock
      : this.copy.trustItems;

  @ViewChild(AddressAutocompleteComponent)
  private readonly autocomplete?: AddressAutocompleteComponent;

  ngOnInit(): void {
    this.seo.setForRoute('');
    // SEO-06: Landing page gets WebSite + FAQPage JSON-LD (single @graph script).
    // No phone/address — omitted until Karan provides public contact details.
    // Site URL comes from SeoService (canonical resolution); copy from ConfigService.
    const faqItems = this.config.get('copy').marketing.faq.items;
    const siteUrl = this.seo.getSiteUrl();
    this.seo.setJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          name: 'Feasly',
          url: `${siteUrl}/`,
          description: this.copy.seoDescription,
          inLanguage: 'en-CA',
        },
        {
          '@type': 'FAQPage',
          mainEntity: faqItems.map((item) => ({
            '@type': 'Question',
            name: item.q,
            acceptedAnswer: { '@type': 'Answer', text: item.a },
          })),
        },
      ],
    });
  }

  /** A suggestion resolved: populate wizard state at step 2 and go to scope. */
  onSelected(property: PropertyRecord): void {
    // A new property starts a new funnel: drop the previous lead receipt and
    // report snapshot so a stale unlock can't leak into the new estimate.
    this.store.dispatch([new ClearLead(), new ClearReport(), new SelectProperty(property), new GoToStep(2)]);
    void this.router.navigate(['/estimate/scope']);
  }

  /**
   * Submit button / Enter with no highlighted suggestion: take the top
   * suggestion if there is one, otherwise nudge for a longer query.
   * Never a dead end — something always happens.
   */
  onSubmit(): void {
    const ac = this.autocomplete;
    if (!ac) return;
    if (ac.pickTop()) return;
    ac.nudgeIfEmpty();
  }
}
