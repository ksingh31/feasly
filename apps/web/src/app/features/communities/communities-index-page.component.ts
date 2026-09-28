import { Component, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import type {
  CommunityAggregate,
  CommunityAggregatesFile,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { buildItemListSchema } from '../../core/seo/jsonld-schemas';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import aggregates from '../../../content/data/community-aggregates.json';
import { toDisplayName } from './community-names';

/**
 * Community index (SEO-05): prerendered `/communities/` listing all 40
 * Calgary community build-cost guides. Each card links to its community
 * page (`/communities/{slug}`); the page is the single crawl hub so no
 * community guide is orphaned.
 *
 * Data: `community-aggregates.json` is a static import — bundled at build
 * time, so teasers render at prerender with no runtime fetch (a dynamic
 * import previously 404'd on the deployed site because the JSON was never
 * in `angular.json` assets).
 *
 * U1 (2026-09-28): cards no longer show a "New build from $X" teaser. The
 * build-cost side of the ranges file is not community-specific (28 of 40
 * communities shared one identical buildLow), so repeating it looked like
 * placeholder data. Each card shows the community's own average assessed
 * value instead; per-community build costs live on the guide pages.
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

  ngOnInit(): void {
    this.seo.setForRoute('communities');
    // SEO: ItemList of every community cost guide — crawlers discover all
    // 40 guides from the hub's structured data, not just the anchor links.
    const siteUrl = this.seo.getSiteUrl();
    this.seo.setJsonLd(
      buildItemListSchema(
        `${siteUrl}/communities/`,
        this.communities.map((c) => ({
          name: `${toDisplayName(c.name)}, Calgary`,
          url: `${siteUrl}/communities/${c.slug}/`,
        })),
      ),
    );
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
