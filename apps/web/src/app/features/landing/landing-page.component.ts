import { Component, computed, DestroyRef, inject, OnInit, signal, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config';
import type { TrustStat } from '../../core/config';
import { API_SERVICE } from '../../core/api';
import { pricingCoverageIssue, type PricingCoverageIssue } from '../../core/utils/coverage';
import { SeoService } from '../../core/seo';
import { buildFaqPageSchema, buildLocalBusinessSchema, buildWebSiteSchema } from '../../core/seo/jsonld-schemas';
import { ClearLead, GoToStep, SelectProperty } from '../wizard';
import { ClearReport } from '../report/report.actions';
import { AddressAutocompleteComponent, SiteFooterComponent, SiteNavComponent } from '../../shared/components';

  /** Stable key of the trust item rewritten with the live refresh month. */
const CITY_DATA_FRESHNESS_KEY = 'city-data-freshness';

/** "September 2026" → "Sep 2026" for the narrow-screen trust value. */
function shortMonthYear(monthYear: string): string {
  const [month = '', year = ''] = monthYear.split(' ');
  return `${month.slice(0, 3)} ${year}`.trim();
}

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
  private readonly destroyRef = inject(DestroyRef);
  private readonly api = inject(API_SERVICE);

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
   * Trust-strip stat blocks with mock-aware substitution: while the mock
   * property harness serves the data, the property-data stat must not claim
   * live City data. Keyed off `propertyData.source` (not `api.useMockApi`):
   * the property backend is an independent switch.
   *
   * On the live path the "Latest data refresh" item is dynamic: once
   * GET /api/v1/city-data/freshness resolves, it reads "<Month
   * Year>"; until then (or when the metadata is unreachable) it keeps the
   * honest "Live City data" fallback from config — never a hardcoded month
   * that goes stale.
   */
  readonly trustStats = computed((): TrustStat[] => {
    if (this.config.get('propertyData').source === 'mock') {
      return this.copy.trustItemsMock;
    }
    const month = this.refreshMonth();
    return this.copy.trustItems.map((item) => {
      if (item.key !== CITY_DATA_FRESHNESS_KEY || !month) return item;
      return {
        ...item,
        value: (item.refreshedValue ?? '{monthYear}').replace('{monthYear}', month),
        valueShort: (item.refreshedValueShort ?? '{monthYearShort}').replace(
          '{monthYearShort}',
          shortMonthYear(month),
        ),
      };
    });
  });

  /** Live dataset-refresh month ("September 2026"); null = unknown/unreachable. */
  private readonly refreshMonth = signal<string | null>(null);

  @ViewChild(AddressAutocompleteComponent)
  private readonly autocomplete?: AddressAutocompleteComponent;

  ngOnInit(): void {
    this.seo.setForRoute('');
    // trust-strip/01: resolve the live dataset-refresh month on the live
    // property path only. A null month (or a failed request) leaves the
    // "Live City data" fallback in place — the strip never claims a month
    // it could not verify.
    if (this.config.get('propertyData').source !== 'mock') {
      this.api
        .getCityDataFreshness()
        .pipe(
          takeUntilDestroyed(this.destroyRef),
          catchError(() => of({ refreshedMonth: null })),
        )
        .subscribe((res) => this.refreshMonth.set(res.refreshedMonth));
    }
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
    // Early coverage guard: stop the funnel HERE — before scope/details —
    // when the engine could never price this property (assessed value out
    // of range), instead of wasting the user's effort and failing at
    // preview. Lot size NEVER blocks (Karan, 2026-09-28): any lot prices,
    // quoted off the house size. The preview page keeps its own guard as a
    // backstop (deep links, API-driven flows).
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
   * (assessed value out of range). Renders the honest can't-price card
   * inline instead of routing into the wizard.
   */
  readonly coverageBlock = signal<{ property: PropertyRecord; issue: PricingCoverageIssue } | null>(
    null,
  );

  /** Buyer-grade explanation for the early coverage block. */
  coverageMessage(block: { property: PropertyRecord; issue: PricingCoverageIssue }): string {
    if (block.issue === 'non-residential') {
      return this.previewCopy.validationNonResidentialBody;
    }
    if (block.issue === 'unsupported-property-type') {
      return this.previewCopy.validationUnsupportedPropertyTypeBody;
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
