import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type {
  CommunityAggregate,
  CommunityAggregatesFile,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import aggregates from '../../../content/data/community-aggregates.json';

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
 * Data: `community-aggregates.json` (static import — renders at prerender).
 * The "from $X" teaser reads `community-ranges.json` (SEO-04) via a
 * best-effort dynamic import: when ranges are unavailable the card still
 * renders name + assessed value, and the teaser appears automatically once
 * SEO-04 lands — no code change needed.
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

  /** Lowest-tier build-low by slug, when the ranges file is available. */
  protected readonly fromPrices = signal<ReadonlyMap<string, number>>(new Map());

  async ngOnInit(): Promise<void> {
    this.seo.setForRoute('communities');
    this.seo.setJsonLd(null);
    // Best-effort: SEO-04's ranges file may not exist yet (separate PR).
    // A missing module rejects at runtime; we degrade to assessed-value-only
    // cards. The path is a variable (not a literal) plus @vite-ignore so
    // neither TypeScript nor Vite statically resolve the optional file.
    try {
      const rangesPath = '../../../content/data/community-ranges.json';
      const mod = (await import(/* @vite-ignore */ rangesPath)) as {
        default: CommunityRangesFile;
      };
      const map = new Map<string, number>();
      for (const c of mod.default.communities) {
        map.set(c.slug, c.tiers.standard.buildLow);
      }
      this.fromPrices.set(map);
    } catch {
      // Ranges unavailable — cards render without the teaser.
    }
  }

  /** "from $X" teaser, or null when ranges are unavailable. */
  fromPrice(community: CommunityAggregate): string | null {
    const low = this.fromPrices().get(community.slug);
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
