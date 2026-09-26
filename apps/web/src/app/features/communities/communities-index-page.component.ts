import { Component, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import type {
  CommunityAggregate,
  CommunityAggregatesFile,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import aggregates from '../../../content/data/community-aggregates.json';
import ranges from '../../../content/data/community-ranges.json';

/** Minimal shape of SEO-04's community-ranges.json (only what the index needs). */
interface CommunityRangesFile {
  readonly communities: readonly {
    readonly slug: string;
    readonly tiers: { readonly standard: { readonly buildLow: number } };
  }[];
}

/**
 * Community index (SEO-05): prerendered `/communities/` listing all 40
 * Calgary community build-cost guides. Each card links to its community
 * page (`/communities/{slug}`); the page is the single crawl hub so no
 * community guide is orphaned.
 *
 * Data: `community-aggregates.json` and `community-ranges.json` are both
 * static imports — bundled at build time, so teasers render at prerender
 * with no runtime fetch (a dynamic import previously 404'd on the deployed
 * site because the JSON was never in `angular.json` assets).
 */
@Component({
  selector: 'app-communities-index-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './communities-index-page.component.html',
  styleUrl: './communities-index-page.component.scss',
})
export class CommunitiesIndexPageComponent implements OnInit {
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  /** Community index copy (config-owned, no hardcoded literals). */
  protected readonly indexCopy = this.config.get('copy').marketing.communities;

  /** 40 communities in aggregate-data order (largest first). */
  protected readonly communities: readonly CommunityAggregate[] = (
    aggregates as CommunityAggregatesFile
  ).communities;

  /** Lowest-tier build-low by slug, from the bundled ranges file. */
  protected readonly fromPrices: ReadonlyMap<string, number> = new Map(
    (ranges as CommunityRangesFile).communities.map((c) => [
      c.slug,
      c.tiers.standard.buildLow,
    ]),
  );

  ngOnInit(): void {
    this.seo.setForRoute('communities');
    this.seo.setJsonLd(null);
  }

  /** "from $X" teaser, or null when the ranges file lacks the community. */
  fromPrice(community: CommunityAggregate): string | null {
    const low = this.fromPrices.get(community.slug);
    return low == null ? null : this.formatCad(low);
  }

  /** Formatted average assessed value, e.g. "$607,351". */
  assessedValue(community: CommunityAggregate): string {
    return this.formatCad(community.avgAssessedValue);
  }

  /** Router link to the community's cost-guide page. */
  communityLink(community: CommunityAggregate): string {
    return `/communities/${community.slug}`;
  }

  private formatCad(value: number): string {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
      maximumFractionDigits: 0,
    }).format(value);
  }
}
