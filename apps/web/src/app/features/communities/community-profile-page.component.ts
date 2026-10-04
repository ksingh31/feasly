import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import type { CommunityProfileCopy, CommunityProfileView, DwellingBucket } from '@feasly/contracts';
import { ClearProfilePropertyContext } from './community-profile.actions';
import { CommunityProfileState } from './community-profile.state';

function formatCad(value: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    maximumFractionDigits: 0,
  }).format(value);
}

function mixPct(view: CommunityProfileView, bucket: DwellingBucket): string {
  return view.dwellingUnits > 0
    ? String(Math.round((view.mix[bucket] / view.dwellingUnits) * 100))
    : '0';
}

/**
 * Fills every {name}/{year}/{avgAssessed}/{multiPct}/{semiPct}/{singlePct}
 * placeholder for one community. Single source of truth for both the
 * rendered page and the FAQPage JSON-LD (the build-output drift guard
 * requires them to byte-match).
 */
export function resolveProfileCopy(
  raw: CommunityProfileCopy,
  view: CommunityProfileView,
): CommunityProfileCopy {
  // NOTE: replaceAll, not replace — several templates contain the same
  // placeholder twice (e.g. {name} in the lede), and String.replace only
  // swaps the first occurrence (live {name} leak, 2026-10-03).
  const fill = (s: string): string =>
    s
      .replaceAll('{name}', view.displayName)
      .replaceAll('{year}', view.assessmentYear)
      .replaceAll('{avgAssessed}', formatCad(view.avgAssessedValue))
      .replaceAll('{multiPct}', mixPct(view, 'multiFamily'))
      .replaceAll('{semiPct}', mixPct(view, 'semiDuplex'))
      .replaceAll('{singlePct}', mixPct(view, 'singleDetached'));
  return {
    ...raw,
    lede: fill(raw.lede),
    communityAverageLabel: fill(raw.communityAverageLabel),
    compareBarLabelTemplate: fill(raw.compareBarLabelTemplate),
    honestNote: fill(raw.honestNote),
    averageHeroLabel: fill(raw.averageHeroLabel),
    homesAssessedSub: fill(raw.homesAssessedSub),
    mixBody: fill(raw.mixBody),
    noBuildBody: fill(raw.noBuildBody),
    finePrint: fill(raw.finePrint),
    faqItems: raw.faqItems.map((item) => ({ q: fill(item.q), a: fill(item.a) })),
  };
}

/**
 * Property-profile page variant (SEO): `/communities/:slug/` for
 * condo/apartment-dominated communities.
 *
 * Purely presentational — the route component (CommunityPageComponent)
 * owns SEO (title/meta/JSON-LD) and decides guide vs profile. Shows real
 * City assessment figures only: average assessed value, dwelling mix,
 * and an honest note explaining why no build-cost guide is published.
 * Never renders build prices.
 */
@Component({
  selector: 'app-community-profile-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './community-profile-page.component.html',
  styleUrl: './community-profile-page.component.scss',
})
export class CommunityProfilePageComponent {
  private readonly store = inject(Store);
  readonly view = input.required<CommunityProfileView>();
  /** Fully-resolved copy (placeholders filled) — render verbatim. */
  readonly copy = input.required<CommunityProfileCopy>();

  /**
   * The rejected property's context, captured once at construction from the
   * estimator's coverage-gate redirect and consumed immediately: the store
   * is cleared right after capture, so every later same-session activation
   * of this component sees null and shows only the community average.
   * The context belongs to the single redirect navigation that created
   * this component instance — it never lingers in the in-memory store.
   */
  readonly propertyContext = signal(
    this.store.selectSnapshot(CommunityProfileState.propertyContext),
  );

  constructor() {
    // Consume-once: clear the transient context immediately after
    // capturing it, so a stale "this property" card can never leak into a
    // later same-session visit (e.g. via the /communities index links).
    this.store.dispatch(new ClearProfilePropertyContext());
  }

  /**
   * Bar widths for the property-vs-average comparison, proportional to the
   * larger of the two values (either can win — a modest property in a
   * pricey community flips the Beltline case). Minimum 2% so the smaller
   * bar stays visible.
   */
  readonly compareBars = computed(() => {
    const avg = this.view().avgAssessedValue;
    const prop = this.propertyContext()?.assessedValue ?? 0;
    const max = Math.max(prop, avg, 1);
    return {
      propertyPct: Math.max(2, (prop / max) * 100),
      averagePct: Math.max(2, (avg / max) * 100),
    };
  });

  /**
   * aria-label for the comparison bars. {name} and {avgAssessed} were
   * filled by resolveProfileCopy; {propertyValue} comes from the transient
   * property context at render time.
   */
  compareBarLabel(assessedValue: number): string {
    return this.copy().compareBarLabelTemplate.replace(
      '{propertyValue}',
      formatCad(assessedValue),
    );
  }

  formatCad(value: number): string {
    return formatCad(value);
  }

  formatInt(value: number): string {
    return value.toLocaleString('en-CA');
  }
}
