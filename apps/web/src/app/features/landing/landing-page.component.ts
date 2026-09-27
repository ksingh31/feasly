import { Component, inject, OnInit, signal, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config';
import { formatLotSizeBody, pricingCoverageIssue, type PricingCoverageIssue } from '../../core/utils/coverage';
import { SeoService } from '../../core/seo';
import { buildFaqPageSchema, buildLocalBusinessSchema, buildWebSiteSchema } from '../../core/seo/jsonld-schemas';
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
  /** Preview-step validation copy, reused for the early coverage guard (same honest wording). */
  readonly previewCopy = this.config.get('copy').preview;
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
    // SEO-06: Landing page gets WebSite + FAQPage + LocalBusiness JSON-LD
    // (single @graph script). FAQ copy comes from ConfigService — the same
    // source as the rendered FAQ, so the drift test can assert byte-equality.
    const faqItems = this.config.get('copy').marketing.faq.items;
    const siteUrl = this.seo.getSiteUrl();
    const webSite = buildWebSiteSchema(siteUrl, this.copy.seoDescription);
    const faqPage = buildFaqPageSchema(faqItems);
    const localBusiness = buildLocalBusinessSchema(siteUrl, `${siteUrl}/`);
    this.seo.setJsonLd({
      '@context': 'https://schema.org',
      '@graph': [webSite, faqPage, localBusiness].map((s) => {
        const { '@context': _ctx, ...rest } = s;
        return rest;
      }),
    });
  }

  /** A suggestion resolved: populate wizard state at step 2 and go to scope. */
  onSelected(property: PropertyRecord): void {
    // Early coverage guard: the lot size is known the moment the address is
    // picked. Stop the funnel HERE — before scope/details — when the engine
    // could never price this lot, instead of wasting the user's effort and
    // failing at preview. The preview page keeps its own guard as a backstop
    // (deep links, API-driven flows).
    const issue = pricingCoverageIssue(property, this.config.get('limits'));
    if (issue !== null) {
      this.coverageBlock.set({ property, issue });
      return;
    }
    this.coverageBlock.set(null);
    // A new property starts a new funnel: drop the previous lead receipt and
    // report snapshot so a stale unlock can't leak into the new estimate.
    this.store.dispatch([new ClearLead(), new ClearReport(), new SelectProperty(property), new GoToStep(2)]);
    void this.router.navigate(['/estimate/scope']);
  }

  /**
   * Property picked from autocomplete that the cost data can't price
   * (lot size or assessed value out of range). Renders the honest
   * can't-price card inline instead of routing into the wizard.
   */
  readonly coverageBlock = signal<{ property: PropertyRecord; issue: PricingCoverageIssue } | null>(
    null,
  );

  /** Buyer-grade explanation for the early coverage block (preview copy, same wording). */
  coverageMessage(block: { property: PropertyRecord; issue: PricingCoverageIssue }): string {
    if (block.issue === 'lot-size') {
      const limits = this.config.get('limits');
      return formatLotSizeBody(
        this.previewCopy.validationLotSizeBody,
        block.property.lotSqft,
        limits.minLotSizeSqft,
        limits.maxLotSizeSqft,
      );
    }
    return this.previewCopy.validationGenericBody;
  }

  /**
   * "← Try a different address": dismiss the block and hand the user a clean
   * search box with focus. Wizard state is untouched — the blocked property
   * was never selected, so there is nothing stale to clear.
   */
  tryDifferentAddress(): void {
    this.coverageBlock.set(null);
    this.autocomplete?.clearSearch();
    this.autocomplete?.focusInput();
  }

  /**
   * Submit button / Enter with no highlighted suggestion: take the top
   * suggestion if there is one, otherwise nudge for a longer query or a
   * pick from the suggestions. Never a dead end — something always
   * happens — and never a proceed: without a resolved address the funnel
   * cannot continue.
   */
  onSubmit(): void {
    const ac = this.autocomplete;
    if (!ac) return;
    if (ac.pickTop()) return;
    ac.nudgeOnSubmit();
  }
}
