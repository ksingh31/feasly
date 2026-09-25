import { Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Meta } from '@angular/platform-browser';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import aggregates from '../../../content/data/community-aggregates.json';
import ranges from '../../../content/data/community-ranges.json';

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
 * Prerendered for every slug in the aggregates JSON. Shows the real average
 * City-assessed value, build-cost ranges per finish tier (computed at build
 * time by the frozen cost engine — this component never sees per-sqft rates
 * or calibration params), a 5-question FAQ, and a CTA to the address step.
 *
 * All figures are planning ranges, not quotes. When the cost data is still
 * uncalibrated, an illustrative banner is shown.
 */
@Component({
  selector: 'app-community-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
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
    this.community = view;
    const title = this.copy.titleTemplate.replace('{name}', view.displayName);
    this.seo.setPage({
      title,
      description: this.copy.descriptionTemplate.replace('{name}', view.displayName),
      path: `/communities/${view.slug}/`,
    });
    this.meta.updateTag({ name: 'feasly:cost-data-version', content: this.costDataVersion });
    this.seo.setJsonLd(null);
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

/**
 * City names are SCREAMING_CASE ("MCKENZIE TOWNE", "DOUGLASDALE/GLEN").
 * Renders them as display names ("McKenzie Towne", "Douglasdale/Glen").
 */
export function toDisplayName(name: string): string {
  return name
    .toLowerCase()
    .split(/([ /-]+)/)
    .map((part) => {
      if (/^[ /-]+$/.test(part) || part.length === 0) return part;
      // Mc/Mac prefix: "mckenzie" -> "McKenzie"
      const mc = part.match(/^(mc|mac)([a-z].*)$/);
      if (mc) return mc[1][0]!.toUpperCase() + mc[1].slice(1) + mc[2][0]!.toUpperCase() + mc[2].slice(1);
      return part[0]!.toUpperCase() + part.slice(1);
    })
    .join('');
}
