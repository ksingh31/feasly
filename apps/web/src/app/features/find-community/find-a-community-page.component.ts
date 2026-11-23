import { isPlatformBrowser } from '@angular/common';
import { Location } from '@angular/common';
import { Component, computed, DestroyRef, inject, OnInit, PLATFORM_ID } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { debounceTime, distinctUntilChanged, map } from 'rxjs';
import type { CommunityMatchImportance, CommunityMatchResult } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { mergeLazyCopy } from '../../core/config/lazy-copy';
import { SeoService } from '../../core/seo';
import { buildWebPageSchema } from '../../core/seo/jsonld-schemas';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { formatEdmontonMediumDate } from '../../shared/utils/edmonton';
import { formatCompactRange } from '../../shared/utils/money';
import {
  ClearMatchCompare,
  CycleMatchPriority,
  LoadCommunityMatches,
  SetMatchSelection,
  ToggleMatchCompare,
  ToggleMatchFilter,
} from './find-community.actions';
import { FindCommunitySelectionState, FindCommunityState } from './find-community.state';
import {
  DEFAULT_FIND_COMMUNITY_COPY,
  type FindCommunityChip,
  type FindCommunityCopy,
} from './find-community-copy.defaults';
import {
  decodeSelection,
  encodeCompareSlugs,
  encodeSelection,
  type MatchFilterKey,
} from './match-selection';

/** Fills `{name}` style placeholders. */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/** A chip with its current state, ready to render. */
export interface ChipView {
  readonly chip: FindCommunityChip;
  readonly label: string;
  /** Pressed = nice, must or (filter) on. */
  readonly pressed: boolean;
  readonly importance: CommunityMatchImportance | null;
  /** Visible state text after the label ('' when off). */
  readonly stateText: string;
}

/**
 * Find a community (#779, phase 1: desktop) at `/find-a-community`.
 *
 * Priority chips (off → Nice to have → Must have → off) and build filters
 * live in NGXS (`FindCommunitySelectionState`, persisted by the storage
 * plugin) and in the URL hash, so a shared link reopens the same ranking:
 * the hash wins over the saved selection. Every selection change sends ONE
 * debounced match request (`LoadCommunityMatches`); ranking, reasons, lot
 * counts and build ranges all come from the API (cost engine), never the
 * client. The compare tray holds up to `limits.communityMatchCompareMax`
 * and links to the side-by-side page (#780, `/find-a-community/compare`).
 *
 * Prerender: the static copy and chips render on the server; the ranking is
 * browser-only (a crawler never triggers a match request).
 */
@Component({
  selector: 'app-find-a-community-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './find-a-community-page.component.html',
  styleUrls: ['../marketing/marketing.scss', './find-a-community-page.component.scss'],
})
export class FindACommunityPageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly copy: FindCommunityCopy = mergeLazyCopy(this.config, DEFAULT_FIND_COMMUNITY_COPY, [
    'findCommunity',
  ]);
  private readonly limits = this.config.get('limits');
  readonly compareMax = this.limits.communityMatchCompareMax;
  private readonly roundingStep = this.limits.estimateRoundingStep;

  readonly selection = this.store.selectSignal(FindCommunitySelectionState.selection);
  readonly status = this.store.selectSignal(FindCommunityState.status);
  readonly response = this.store.selectSignal(FindCommunityState.response);
  readonly compare = this.store.selectSignal(FindCommunityState.compare);
  readonly compareBlocked = this.store.selectSignal(FindCommunityState.compareBlocked);

  private readonly knownPriorities = new Set(
    this.copy.groups.flatMap((g) => g.chips.filter((c) => c.kind === 'priority').map((c) => c.key)),
  );

  /** Chip groups with each chip's pressed state. */
  readonly groups = computed(() => {
    const selection = this.selection();
    return this.copy.groups.map((group) => ({
      id: group.id,
      title: group.title,
      chips: group.chips.map((chip): ChipView => {
        const label = fill(chip.label, { ft: this.limits.communityMatchWideLotFrontageFt });
        if (chip.kind === 'filter') {
          const on = selection.filters.includes(chip.key);
          return { chip, label, pressed: on, importance: null, stateText: on ? this.copy.stateOn : '' };
        }
        const importance = selection.priorities.find((p) => p.key === chip.key)?.importance ?? null;
        const stateText =
          importance === 'must' ? this.copy.stateMust : importance === 'nice' ? this.copy.stateNice : '';
        return { chip, label, pressed: importance !== null, importance, stateText };
      }),
    }));
  });

  readonly hasPriorities = computed(() => this.selection().priorities.length > 0);

  readonly results = computed(() => this.response()?.results ?? []);

  readonly resultsCount = computed(() => {
    const response = this.response();
    if (!response) return '';
    return fill(this.copy.resultsCount, { count: response.results.length, total: response.total });
  });

  /** Live-region text for the results column. */
  readonly statusText = computed(() => {
    if (!this.hasPriorities()) return this.copy.emptyPrompt;
    switch (this.status()) {
      case 'loading':
        return this.copy.loading;
      case 'error':
        return this.copy.error;
      case 'ready':
        return this.results().length === 0 ? this.copy.noResults : this.resultsCount();
      default:
        return '';
    }
  });

  readonly compareCodes = computed(() => new Set(this.compare().map((c) => c.communityCode)));

  readonly compareCount = computed(() =>
    fill(this.copy.compareTrayCount, { count: this.compare().length, max: this.compareMax }),
  );

  /** Compare page link hash (#780): the ticked communities' slugs, in tick order. */
  readonly compareFragment = computed(() => encodeCompareSlugs(this.compare().map((c) => c.slug)));

  readonly compareLimitText = fill(this.copy.compareLimit, { max: this.compareMax });

  readonly buildBasis = computed(() => {
    const basis = this.response()?.buildBasis;
    return basis ? fill(this.copy.buildBasis, { sqft: basis.buildSqft.toLocaleString('en-CA') }) : '';
  });

  readonly refreshed = computed(() => {
    const at = this.response()?.dataRefreshedAt;
    return at ? fill(this.copy.refreshed, { date: formatEdmontonMediumDate(at) }) : '';
  });

  constructor() {
    if (!this.isBrowser) return;
    // A shared link wins over the saved selection (#779 AC2).
    const fromLink = decodeSelection(this.route.snapshot.fragment, this.knownPriorities);
    if (fromLink) this.store.dispatch(new SetMatchSelection(fromLink));

    // One request per settled change (#779 AC1): rapid taps collapse into
    // a single request after the debounce.
    const selection$ = toObservable(this.selection).pipe(
      map((selection) => ({ selection, key: encodeSelection(selection) })),
      distinctUntilChanged((a, b) => a.key === b.key),
    );
    selection$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ key }) => this.writeHash(key));
    selection$
      .pipe(
        debounceTime(this.limits.communityMatchDebounceMs),
        // Taps that net out to the last ranked selection send nothing.
        distinctUntilChanged((a, b) => a.key === b.key),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.store.dispatch(new LoadCommunityMatches()));
  }

  ngOnInit(): void {
    this.seo.setForRoute('find-a-community');
    const pageUrl = `${this.seo.getSiteUrl()}/find-a-community/`;
    this.seo.setJsonLd(
      buildWebPageSchema(pageUrl, this.copy.title, this.config.get('copy').seo.findCommunity),
    );
  }

  onChip(view: ChipView): void {
    if (view.chip.kind === 'filter') {
      this.store.dispatch(new ToggleMatchFilter(view.chip.key as MatchFilterKey));
    } else {
      this.store.dispatch(new CycleMatchPriority(view.chip.key));
    }
  }

  retry(): void {
    this.store.dispatch(new LoadCommunityMatches());
  }

  /**
   * Compare checkbox: a tick past the max is refused by the state (#779
   * AC3), so the box is re-synced to the state rather than trusting the
   * browser's toggle.
   */
  onCompareChange(result: CommunityMatchResult, event: Event): void {
    this.store.dispatch(new ToggleMatchCompare(result.communityCode));
    (event.target as HTMLInputElement).checked = this.compareCodes().has(result.communityCode);
  }

  removeCompare(code: string): void {
    this.store.dispatch(new ToggleMatchCompare(code));
  }

  clearCompare(): void {
    this.store.dispatch(new ClearMatchCompare());
  }

  matchLabel(result: CommunityMatchResult): string {
    return fill(this.copy.matchLabel, { match: result.match });
  }

  lotsText(result: CommunityMatchResult): string {
    const { listed, matching } = result.lots;
    if (listed === 0) return this.copy.noLots;
    if (matching !== listed) return fill(this.copy.lotsMatching, { matching, listed });
    return fill(this.copy.lotsListed, { listed });
  }

  buildRange(result: CommunityMatchResult): string {
    return result.typicalNewBuild
      ? formatCompactRange(result.typicalNewBuild, this.roundingStep)
      : this.copy.noBuildRange;
  }

  label(template: string, name: string): string {
    return fill(template, { name });
  }

  /** Keeps the link shareable: replaceState, so Back isn't filled with every tap. */
  private writeHash(key: string): void {
    const path = this.location.path(false).split('#')[0];
    this.location.replaceState(key ? `${path}#${key}` : path);
  }
}
