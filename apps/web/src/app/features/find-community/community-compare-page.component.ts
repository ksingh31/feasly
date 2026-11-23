import { DOCUMENT, isPlatformBrowser, Location } from '@angular/common';
import { Component, computed, DestroyRef, inject, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { CommunityCompareCell, CommunityCompareRow } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { mergeLazyCopy } from '../../core/config/lazy-copy';
import { SeoService } from '../../core/seo';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { formatEdmontonMediumDate } from '../../shared/utils/edmonton';
import { formatCompactRange } from '../../shared/utils/money';
import { LoadCommunityCompare } from './find-community.actions';
import { CommunityCompareState, FindCommunitySelectionState } from './find-community.state';
import { DEFAULT_FIND_COMMUNITY_COPY, type FindCommunityCopy } from './find-community-copy.defaults';
import { decodeCompareSlugs, encodeCompareSlugs } from './match-selection';

/** Fills `{name}` style placeholders. */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/** One row ready to render. */
export interface CompareRowView {
  readonly row: CommunityCompareRow;
  /** The row answers one of the visitor's must-have priorities. */
  readonly must: boolean;
}

/** One row group (Schools / Getting around / Lifestyle / Building here). */
export interface CompareGroupView {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly CompareRowView[];
}

/** Row group for build rows and for priorities with no chip group. */
const BUILDING_GROUP = 'building';
const FALLBACK_GROUP = 'lifestyle';

/**
 * Compare communities side by side (#780) at
 * `/find-a-community/compare#a,b,c` — 2 or 3 community slugs in the hash.
 *
 * The link is the source of truth, so a shared link opens the same columns.
 * Rows, values and the best value per row all come from the API
 * (`GET /communities/compare`, cost engine for build ranges); this page only
 * places rows into the four groups (by the find page's chip groups) and puts
 * the visitor's saved must-have rows first. noindex: a crawler sees no hash.
 */
@Component({
  selector: 'app-community-compare-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './community-compare-page.component.html',
  styleUrls: ['../marketing/marketing.scss', './community-compare-page.component.scss'],
})
export class CommunityComparePageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly findCopy: FindCommunityCopy = mergeLazyCopy(this.config, DEFAULT_FIND_COMMUNITY_COPY, [
    'findCommunity',
  ]);
  readonly copy = this.findCopy.comparePage;
  readonly draftCostData = this.findCopy.draftCostData;
  private readonly limits = this.config.get('limits');

  readonly selection = this.store.selectSignal(FindCommunitySelectionState.selection);
  readonly status = this.store.selectSignal(CommunityCompareState.status);
  readonly response = this.store.selectSignal(CommunityCompareState.response);
  readonly retryable = this.store.selectSignal(CommunityCompareState.retryable);

  /** Slugs from the link (valid, unique, at most the compare max). */
  readonly slugs = signal<readonly string[]>([]);
  /** False until the hash has been read (avoids flashing "pick 2" on load). */
  readonly linkRead = signal(false);
  readonly enough = computed(() => this.slugs().length >= 2);

  readonly copyState = signal<'idle' | 'copied' | 'error'>('idle');
  readonly copyStatus = computed(() => {
    switch (this.copyState()) {
      case 'copied':
        return this.copy.linkCopied;
      case 'error':
        return this.copy.linkCopyFailed;
      default:
        return '';
    }
  });

  /** The comparison to render: only for a valid link once loaded. */
  readonly shown = computed(() => (this.enough() && this.status() === 'ready' ? this.response() : null));

  readonly communities = computed(() => this.response()?.communities ?? []);

  /** Chip priority key → find-page chip group id (Schools, Getting around, Lifestyle). */
  private readonly groupByPriority = new Map(
    this.findCopy.groups.flatMap((g) =>
      g.chips.filter((c) => c.kind === 'priority').map((c) => [c.key, g.id] as const),
    ),
  );

  private readonly mustKeys = computed(
    () => new Set(this.selection().priorities.filter((p) => p.importance === 'must').map((p) => p.key)),
  );

  /** Groups in copy order, must-have rows first; groups holding a must-have lead. */
  readonly groups = computed((): CompareGroupView[] => {
    const response = this.response();
    if (!response) return [];
    const must = this.mustKeys();
    const known = new Set(this.copy.groups.map((g) => g.id));
    const byGroup = new Map<string, CompareRowView[]>();
    for (const row of response.rows) {
      const id = this.groupOf(row, known);
      const list = byGroup.get(id) ?? [];
      list.push({ row, must: row.priority !== null && must.has(row.priority) });
      byGroup.set(id, list);
    }
    const groups = this.copy.groups
      .map((g) => {
        const rows = byGroup.get(g.id) ?? [];
        return { id: g.id, title: g.title, rows: [...rows.filter((r) => r.must), ...rows.filter((r) => !r.must)] };
      })
      .filter((g) => g.rows.length > 0);
    const leading = (g: CompareGroupView): number => (g.rows.some((r) => r.must) ? 0 : 1);
    return groups
      .map((g, i) => ({ g, i }))
      .sort((a, b) => leading(a.g) - leading(b.g) || a.i - b.i)
      .map(({ g }) => g);
  });

  readonly buildBasis = computed(() => {
    const basis = this.response()?.buildBasis;
    return basis ? fill(this.findCopy.buildBasis, { sqft: basis.buildSqft.toLocaleString('en-CA') }) : '';
  });

  readonly refreshed = computed(() => {
    const at = this.response()?.dataRefreshedAt;
    return at ? fill(this.findCopy.refreshed, { date: formatEdmontonMediumDate(at) }) : '';
  });

  /** Live-region text above the table. */
  readonly statusText = computed(() => {
    if (!this.linkRead()) return '';
    if (!this.enough()) return this.copy.needTwo;
    switch (this.status()) {
      case 'loading':
        return this.copy.loading;
      case 'error':
        return this.retryable() ? this.copy.error : this.copy.notFound;
      default:
        return '';
    }
  });

  constructor() {
    if (!this.isBrowser) return;
    // The hash is the source of truth (#780 AC1: a shared link works). A
    // hand-edited hash reloads the comparison.
    this.route.fragment.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((fragment) => {
      const slugs = decodeCompareSlugs(fragment, this.limits.communityMatchCompareMax);
      this.slugs.set(slugs);
      this.linkRead.set(true);
      this.copyState.set('idle');
      if (slugs.length >= 2) this.store.dispatch(new LoadCommunityCompare(slugs));
    });
  }

  ngOnInit(): void {
    this.seo.setForRoute('find-a-community/compare');
  }

  retry(): void {
    if (this.enough()) this.store.dispatch(new LoadCommunityCompare(this.slugs()));
  }

  /** "Copy link": the page URL with the current columns in the hash. */
  async copyLink(): Promise<void> {
    const path = this.location.prepareExternalUrl(this.location.path(false).split('#')[0] ?? '');
    const url = new URL(path, this.document.location.origin);
    url.hash = encodeCompareSlugs(this.slugs());
    try {
      await navigator.clipboard.writeText(url.toString());
      this.copyState.set('copied');
    } catch {
      this.copyState.set('error');
    }
  }

  /** Cell text: build ranges formatted like the find page; everything else as the API wrote it. */
  cellText(cell: CommunityCompareCell): string {
    return cell.range ? formatCompactRange(cell.range, this.limits.estimateRoundingStep) : cell.text;
  }

  label(template: string, name: string): string {
    return fill(template, { name });
  }

  private groupOf(row: CommunityCompareRow, known: ReadonlySet<string>): string {
    if (row.kind === 'building') return BUILDING_GROUP;
    const id = row.priority !== null ? this.groupByPriority.get(row.priority) : undefined;
    return id && known.has(id) ? id : FALLBACK_GROUP;
  }
}
