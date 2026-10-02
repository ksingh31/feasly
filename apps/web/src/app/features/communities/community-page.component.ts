import { Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Meta } from '@angular/platform-browser';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { buildFaqPageSchema, buildLocalBusinessSchema } from '../../core/seo/jsonld-schemas';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { nearbyCommunities } from '../../core/community/nearby-communities';
import aggregates from '../../../content/data/community-aggregates.json';
import mixData from '../../../content/data/community-mix.json';
import ranges from '../../../content/data/community-ranges.json';
import type { CommunityDwellingMix, CommunityMixFile, CommunityType } from '@feasly/contracts';
import {
  CommunityProfilePageComponent,
  resolveProfileCopy,
  type CommunityProfileCopy,
  type CommunityProfileView,
} from './community-profile-page.component';
import { toDisplayName } from './community-names';

interface TierRow {
  key: 'standard' | 'premium' | 'luxury';
  label: string;
  buildLow: number;
  buildHigh: number;
  landValue: number;
  totalLow: number;
  totalHigh: number;
}

interface CommunityView {
  slug: string;
  name: string;
  displayName: string;
  count: number;
  avgAssessedValue: number;
  avgLotSqft: number;
  tiers: TierRow[];
}

/**
 * Community page (SEO-04): `/communities/:slug/`.
 *
 * Two variants, chosen by the community's type in `community-mix.json`:
 * - `build-guide`: the single-family build-cost guide — real average
 *   City-assessed value, build-cost ranges per finish tier (computed at build
 *   time by the frozen cost engine — this component never sees per-sqft rates
 *   or calibration params), a 5-question FAQ, and a CTA to the address step.
 * - `profile`: condo/apartment-dominated communities where a per-house build
 *   figure would be misleading — a property-values profile instead (average
 *   assessed value, dwelling mix, assessment explainer, assessment FAQs).
 *   Never renders build prices.
 *
 * Prerendered for every slug in the aggregates JSON. All figures are
 * planning ranges / assessment records, not quotes. When the cost data is
 * still uncalibrated, an illustrative banner is shown on guide pages.
 */
@Component({
  selector: 'app-community-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent, CommunityProfilePageComponent],
  templateUrl: './community-page.component.html',
  styleUrl: './community-page.component.scss',
})
export class CommunityPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly meta = inject(Meta);
  private readonly config = inject(ConfigService);

  /** Static page copy (config-owned). */
  readonly copy = this.config.get('copy').communities;

  /** The community being rendered, or null when the slug is unknown. */
  community: CommunityView | null = null;

  /** Profile variant view + resolved copy (null for build-guide pages). */
  profileView: CommunityProfileView | null = null;
  profileCopy: CommunityProfileCopy | null = null;

  /** Cost-data version for the meta tag. */
  readonly costDataVersion: string = (ranges as { costDataVersion: string }).costDataVersion;

  /** Whether the figures are calibrated (hides the illustrative banner). */
  readonly calibrated: boolean = (ranges as { calibrated: boolean }).calibrated;

  /** Build sqft the ranges assume (from the build artifact, not hardcoded). */
  readonly buildSqft: number = (ranges as { buildSqft: number }).buildSqft;

  /** FAQ accordion open state. */
  openFaq: number | null = null;

  /** FAQ items from config (short alias for the template). */
  get faqs(): { q: string; a: string }[] {
    return this.copy.faqItems;
  }

  ngOnInit(): void {
    const slug = this.route.snapshot.paramMap.get('slug') ?? '';
    const view = this.buildView(slug);
    if (!view) {
      // Unknown slug — the branded 404 route (path is a route, not a tunable).
      void this.router.navigate([NOT_FOUND_PATH]);
      return;
    }
    const communityType = this.communityTypeOf(slug);
    if (communityType === 'profile') {
      this.renderProfile(view, slug);
      return;
    }
    this.community = view;
    const title = this.copy.titleTemplate.replace('{name}', view.displayName);
    // The meta description carries the real per-community assessed value so
    // all community pages have unique descriptions in search results
    // (template-only copy would be near-duplicate across pages).
    const description = this.copy.descriptionTemplate
      .replace('{name}', view.displayName)
      .replace('{avgAssessed}', this.formatCad(view.avgAssessedValue));
    this.seo.setPage({
      title,
      description,
      path: `/communities/${view.slug}/`,
    });
    this.meta.updateTag({ name: 'feasly:cost-data-version', content: this.costDataVersion });
    // SEO-06: FAQPage + LocalBusiness JSON-LD for rich results.
    const pagePath = `/communities/${view.slug}/`;
    this.seo.setJsonLdScript('faq', buildFaqPageSchema(this.copy.faqItems));
    this.seo.setJsonLdScript(
      'business',
      buildLocalBusinessSchema(this.seo.getSiteUrl(), `${this.seo.getSiteUrl()}${pagePath}`),
    );
  }

  /** Interpolates the community name into a copy template. */
  fill(template: string): string {
    return template.replace('{name}', this.community?.displayName ?? '');
  }

  toggleFaq(index: number): void {
    this.openFaq = this.openFaq === index ? null : index;
  }

  /** Formats whole CAD dollars (no cents — money is integer downstream). */
  formatCad(value: number): string {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
      maximumFractionDigits: 0,
    }).format(value);
  }

  /**
   * Land's share of the tier total as a 0–100 percentage, computed against
   * the build-range midpoint (land is a fixed value, build is a range).
   * Drives the CSS-only land-vs-build split bar.
   */
  landSharePct(tier: TierRow): number {
    const buildMid = (tier.buildLow + tier.buildHigh) / 2;
    const total = tier.landValue + buildMid;
    return total > 0 ? (tier.landValue / total) * 100 : 0;
  }

  /** Build's share of the tier total — the complement of landSharePct. */
  buildSharePct(tier: TierRow): number {
    return 100 - this.landSharePct(tier);
  }

  /**
   * Text equivalent for the split bar (the bar must never be color-only
   * for assistive tech). Interpolates the config-owned label template.
   */
  splitBarLabel(tier: TierRow): string {
    const landPct = Math.round(this.landSharePct(tier));
    return this.copy.splitBarLabelTemplate
      .replace('{land}', this.formatCad(tier.landValue))
      .replace('{landPct}', String(landPct))
      .replace('{build}', `${this.formatCad(tier.buildLow)}–${this.formatCad(tier.buildHigh)}`)
      .replace('{buildPct}', String(100 - landPct));
  }

  /**
   * Renders the property-profile variant: builds the view model, resolves
   * config copy placeholders, and sets profile SEO (honest titles — no
   * build-cost claims) with FAQPage + LocalBusiness JSON-LD.
   */
  private renderProfile(view: CommunityView, slug: string): void {
    const mix = this.mixEntry(slug);
    const allAggs = (aggregates as { communities: AggregateRow[] }).communities;
    const nearby = nearbyCommunities(
      slug,
      allAggs.map((c) => ({ slug: c.slug, count: c.count })),
    ).map((nearSlug) => {
      const agg = allAggs.find((c) => c.slug === nearSlug);
      return { slug: nearSlug, displayName: toDisplayName(agg?.name ?? nearSlug) };
    });
    const profileView: CommunityProfileView = {
      slug: view.slug,
      displayName: view.displayName,
      avgAssessedValue: view.avgAssessedValue,
      assessmentYear: (mixData as CommunityMixFile).assessmentYear,
      dwellingUnits: mix?.dwellingUnits ?? 0,
      mix: mix?.mix ?? { singleDetached: 0, semiDuplex: 0, multiFamily: 0 },
      mostCommonType: mix?.mostCommonType ?? 'multiFamily',
      nearby,
    };
    const resolved = resolveProfileCopy(
      {
        ...this.copy.profile,
        // Reuse the guide's assessed-value label/note — same figure semantics.
        statLabel: this.copy.statLabel,
        statNote: this.copy.statNote,
      },
      profileView,
    );
    this.profileView = profileView;
    this.profileCopy = resolved;

    const title = this.copy.profile.titleTemplate.replace('{name}', view.displayName);
    const description = this.copy.profile.descriptionTemplate
      .replace('{name}', view.displayName)
      .replace('{avgAssessed}', this.formatCad(view.avgAssessedValue));
    this.seo.setPage({
      title,
      description,
      path: `/communities/${view.slug}/`,
    });
    this.meta.updateTag({ name: 'feasly:cost-data-version', content: this.costDataVersion });
    const pagePath = `/communities/${view.slug}/`;
    this.seo.setJsonLdScript('faq', buildFaqPageSchema(resolved.faqItems));
    this.seo.setJsonLdScript(
      'business',
      buildLocalBusinessSchema(this.seo.getSiteUrl(), `${this.seo.getSiteUrl()}${pagePath}`),
    );
  }

  private mixEntry(slug: string): CommunityDwellingMix | undefined {
    return (mixData as CommunityMixFile).communities.find((c) => c.slug === slug);
  }

  private communityTypeOf(slug: string): CommunityType {
    return this.mixEntry(slug)?.communityType ?? 'build-guide';
  }

  private buildView(slug: string): CommunityView | null {
    const agg = (aggregates as { communities: AggregateRow[] }).communities.find((c) => c.slug === slug);
    const range = (ranges as { communities: RangeRow[] }).communities.find((c) => c.slug === slug);
    if (!agg || !range) return null;
    const displayName = toDisplayName(agg.name);
    const tierLabels: Record<TierRow['key'], string> = {
      standard: 'Standard',
      premium: 'Premium',
      luxury: 'Luxury',
    };
    const tiers: TierRow[] = (['standard', 'premium', 'luxury'] as const).map((key) => ({
      key,
      label: tierLabels[key],
      ...range.tiers[key],
    }));
    return {
      slug: agg.slug,
      name: agg.name,
      displayName,
      count: agg.count,
      avgAssessedValue: agg.avgAssessedValue,
      avgLotSqft: agg.avgLotSqft,
      tiers,
    };
  }
}

interface AggregateRow {
  slug: string;
  name: string;
  count: number;
  avgAssessedValue: number;
  avgLotSqft: number;
}

interface RangeRow {
  slug: string;
  tiers: Record<'standard' | 'premium' | 'luxury', Omit<TierRow, 'key' | 'label'>>;
}

/** Branded 404 path for unknown slugs. */
const NOT_FOUND_PATH = '/404';
