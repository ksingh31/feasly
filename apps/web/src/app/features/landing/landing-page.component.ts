import { afterNextRender, Component, computed, inject, OnInit, signal, ViewChild } from '@angular/core';
import { Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config';
import type { TrustStat } from '../../core/config';
import { DataFreshnessService, formatFreshnessLine } from '../../core/data-freshness';
import { pricingCoverageIssue, type PricingCoverageIssue } from '../../core/utils/coverage';
import { SeoService } from '../../core/seo';
import { buildFaqPageSchema, buildLocalBusinessSchema, buildWebSiteSchema } from '../../core/seo/jsonld-schemas';
import { ClearLead, DismissResume, GoToStep, ResetWizard, SelectProperty, SetEntrySource, WizardState } from '../wizard';
import { ClearReport } from '../report/report.actions';
import { ReportState } from '../report/report.state';
import { AnalyticsService } from '../consent/analytics.service';
import { AddressAutocompleteComponent, SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { parseDeepLinkAddress, parseDeepLinkSource } from '../../shared/utils/deep-link';
import { CommunityService } from '../../core/community/community.service';
import { SetProfilePropertyContext } from '../communities/community-profile.actions';

/** Estimator deep-link query parameters (#692). */
const DEEP_LINK_ADDRESS_PARAM = 'address';
const DEEP_LINK_SOURCE_PARAM = 'src';

/** Stable key of the trust item rewritten into the shared freshness line. */
const CITY_DATA_FRESHNESS_KEY = 'city-data-freshness';

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
  private readonly dataFreshness = inject(DataFreshnessService);
  private readonly communityService = inject(CommunityService);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);

  constructor() {
    // #692: the deep link is read in the browser only, after hydration. The
    // prerendered `/` HTML is what every `/?address=…` request gets first,
    // so the server render must never depend on the query string.
    afterNextRender(() => {
      // #704: the resume chip reads rehydrated localStorage state, which the
      // server render never has — show it only after hydration so the
      // prerendered HTML and the first client render match.
      this.browserReady.set(true);
      this.applyDeepLink();
    });
  }

  private readonly analytics = inject(AnalyticsService);

  /** Returning-user copy (#704): find-my-report link + resume chip. */
  readonly returningCopy = this.config.get('copy').returning;

  private readonly browserReady = signal(false);
  private readonly storedProperty = this.store.selectSignal(WizardState.property);
  private readonly storedPreview = this.store.selectSignal(WizardState.preview);
  private readonly storedSnapshot = this.store.selectSignal(ReportState.snapshot);
  private readonly resumeDismissed = this.store.selectSignal(WizardState.resumeDismissed);

  /**
   * Same-device resume chip (#704): shown when this browser holds an
   * in-progress estimate (a selected property) or a stored report for it,
   * until dismissed. Continues to the furthest point reached: the report,
   * else the preview, else the scope step. Null = render nothing.
   */
  readonly resume = computed((): { label: string; path: string } | null => {
    if (!this.browserReady() || this.resumeDismissed()) return null;
    const property = this.storedProperty();
    if (!property) return null;
    const snapshot = this.storedSnapshot();
    const hasReport =
      snapshot !== null && (!snapshot.addressKey || snapshot.addressKey === property.addressKey);
    const path = hasReport
      ? '/estimate/report'
      : this.storedPreview() !== null
        ? '/estimate/preview'
        : '/estimate/scope';
    return {
      label: this.returningCopy.resumeLabel.replace('{address}', property.address),
      path,
    };
  });

  /** Resume chip followed (consent-gated analytics; no address in the event). */
  onResume(): void {
    this.analytics.track('report_resume');
  }

  /** Hide the resume chip until the next new estimate. */
  dismissResume(): void {
    this.store.dispatch(new DismissResume());
  }

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
   * On the live path the freshness item is dynamic (#513): once
   * GET /api/v1/city-data/freshness resolves, it shows the shared
   * freshness line — value "2026 assessment roll", label "(City of
   * Calgary) · checked Nov 2026" — the exact string the property card
   * shows. Until then (or when the metadata is unreachable) it keeps the
   * honest config fallback — never a hardcoded year or month that goes stale.
   */
  readonly trustStats = computed((): TrustStat[] => {
    if (this.config.get('propertyData').source === 'mock') {
      return this.copy.trustItemsMock;
    }
    const { rollYear, refreshedMonth } = this.dataFreshness.freshness();
    return this.copy.trustItems.map((item) => {
      if (item.key !== CITY_DATA_FRESHNESS_KEY || (rollYear === null && !refreshedMonth)) return item;
      const { lead, detail } = formatFreshnessLine(
        this.config.get('copy').dataFreshness,
        rollYear,
        refreshedMonth,
      );
      return { ...item, value: lead, valueShort: lead, label: detail };
    });
  });

  @ViewChild(AddressAutocompleteComponent)
  private readonly autocomplete?: AddressAutocompleteComponent;

  ngOnInit(): void {
    this.seo.setForRoute('');
    // trust-strip/01 + #513: resolve the shared freshness (no-op on the
    // mock property path). Unknown parts keep the honest fallback — the
    // strip never claims a year or month it could not verify.
    this.dataFreshness.load();
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

  /**
   * Estimator deep link (#692): `/?address=<text>&src=<source>`.
   *
   * - Any `address`/`src` parameter marks the page noindex (the canonical
   *   already points at the parameter-free landing URL).
   * - Both parameters are removed from the address bar once read, so Back
   *   from the scope step returns to a plain landing page instead of
   *   running the lookup again (no forward loop). Other parameters stay.
   * - A valid address starts a fresh wizard and is looked up exactly like
   *   typed input; the autocomplete takes it from there (sole match →
   *   `onSelected`, several → picker, none/out of coverage → its message).
   * - An over-long or malformed address is ignored: plain landing page.
   * - `src` is kept only when it is on the config allowlist.
   */
  private applyDeepLink(): void {
    const params = this.route.snapshot.queryParamMap;
    if (!params.has(DEEP_LINK_ADDRESS_PARAM) && !params.has(DEEP_LINK_SOURCE_PARAM)) return;

    this.seo.setNoindex();
    this.removeDeepLinkParams();

    const deepLink = this.config.get('deepLink');
    const address = parseDeepLinkAddress(params.get(DEEP_LINK_ADDRESS_PARAM), {
      minLength: deepLink.addressMinLength,
      maxLength: deepLink.addressMaxLength,
    });
    const source = parseDeepLinkSource(params.get(DEEP_LINK_SOURCE_PARAM), deepLink.sources);

    if (address !== null) {
      // Fresh funnel: nothing from an earlier estimate mixes into this one.
      this.store.dispatch([new ClearLead(), new ClearReport(), new ResetWizard()]);
    }
    if (source !== null) {
      this.store.dispatch(new SetEntrySource(source));
    }
    if (address !== null) {
      this.autocomplete?.prefill(address);
    }
  }

  /** Drops the deep-link parameters from the address bar (no navigation, no history entry). */
  private removeDeepLinkParams(): void {
    const tree = this.router.parseUrl(this.location.path());
    delete tree.queryParams[DEEP_LINK_ADDRESS_PARAM];
    delete tree.queryParams[DEEP_LINK_SOURCE_PARAM];
    this.location.replaceState(this.router.serializeUrl(tree));
  }

  /** A suggestion resolved: populate wizard state at step 2 and go to scope. */
  onSelected(property: PropertyRecord): void {
    // Early coverage guard: stop the funnel HERE — before scope/details —
    // when the engine could never price this property (assessed value out
    // of range), instead of wasting the user's effort and failing at
    // preview. Lot size NEVER blocks (Karan, 2026-09-28): any lot prices,
    // quoted off the house size. The preview page keeps its own guard as a
    // backstop (deep links, API-driven flows).
    //
    // Karan (2026-10-02): instead of a dead-end card, redirect to the
    // community profile page showing the property's assessed value vs the
    // community average. Falls back to the inline card only when the
    // community isn't recognized (never fabricate a profile).
    const issue = pricingCoverageIssue(
      property,
      this.config.get('limits'),
      this.config.get('coverage').singleFamilyDistricts.calgary,
    );
    if (issue !== null) {
      const community = this.communityService.byName(property.community);
      if (community) {
        this.store.dispatch(
          new SetProfilePropertyContext({
            address: property.address,
            assessedValue: property.assessedValue,
          }),
        );
        void this.router.navigate(['/communities', community.slug]);
        return;
      }
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
   * Submit button / Enter with no highlighted suggestion: take the
   * suggestion only when it is the sole match (#486), otherwise nudge for a
   * longer query or a pick from the (re-opened) suggestions. Never a dead end — something always
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
