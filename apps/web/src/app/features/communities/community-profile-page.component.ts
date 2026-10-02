import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import type { DwellingBucket } from '@feasly/contracts';

/** View model for one property-profile community page. All figures are real City assessment data. */
export interface CommunityProfileView {
  readonly slug: string;
  readonly displayName: string;
  /** All-residential average City-assessed value (same figure as the index card). */
  readonly avgAssessedValue: number;
  /** Assessment roll year, e.g. "2026". */
  readonly assessmentYear: string;
  /** Residential dwelling records behind the mix (excludes common elements/parking/storage). */
  readonly dwellingUnits: number;
  readonly mix: Readonly<Record<DwellingBucket, number>>;
  readonly mostCommonType: DwellingBucket;
  /** Up to 3 nearby community slugs (display names resolved from the aggregates). */
  readonly nearby: readonly { slug: string; displayName: string }[];
}

/**
 * Raw profile copy from config — carries {name}, {year}, {avgAssessed},
 * {multiPct}, {semiPct}, {singlePct} placeholders. Use
 * `resolveProfileCopy` to fill them; never render raw.
 */
export interface CommunityProfileCopy {
  readonly kicker: string;
  readonly lede: string;
  readonly homesAssessedLabel: string;
  readonly homesAssessedSub: string;
  readonly mostCommonTypeLabel: string;
  readonly assessmentYearLabel: string;
  readonly mixTitle: string;
  readonly mixBody: string;
  readonly mixBarLabelTemplate: string;
  readonly typeLabels: Readonly<Record<DwellingBucket, string>>;
  readonly noBuildTitle: string;
  readonly noBuildBody: string;
  readonly noBuildGuideLink: string;
  readonly explainerTitle: string;
  readonly explainerItems: readonly { title: string; body: string }[];
  readonly faqTitle: string;
  readonly faqItems: readonly { q: string; a: string }[];
  readonly nearbyTitle: string;
  readonly ctaTitle: string;
  readonly ctaBody: string;
  readonly ctaEstimateLabel: string;
  readonly ctaGuideLabel: string;
  readonly finePrint: string;
  readonly statLabel: string;
  readonly statNote: string;
}

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
  const fill = (s: string): string =>
    s
      .replace('{name}', view.displayName)
      .replace('{year}', view.assessmentYear)
      .replace('{avgAssessed}', formatCad(view.avgAssessedValue))
      .replace('{multiPct}', mixPct(view, 'multiFamily'))
      .replace('{semiPct}', mixPct(view, 'semiDuplex'))
      .replace('{singlePct}', mixPct(view, 'singleDetached'));
  return {
    ...raw,
    lede: fill(raw.lede),
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
  readonly view = input.required<CommunityProfileView>();
  /** Fully-resolved copy (placeholders filled) — render verbatim. */
  readonly copy = input.required<CommunityProfileCopy>();

  /** FAQ items (short alias for the template — keeps the @for line under the no-hardcode length tripwire). */
  faqs(): readonly { q: string; a: string }[] {
    return this.copy().faqItems;
  }

  /** FAQ open state. */
  openFaq: number | null = null;

  /** Mix percentages, rounded, in bucket order for the stacked bar. */
  readonly mixSegments = computed(() => {
    const v = this.view();
    const order: DwellingBucket[] = ['multiFamily', 'semiDuplex', 'singleDetached'];
    return order.map((bucket) => ({
      bucket,
      label: this.copy().typeLabels[bucket],
      pct: Number(mixPct(v, bucket)),
    }));
  });

  /** aria-label text equivalent for the mix bar (never color-only). */
  mixBarLabel(): string {
    const v = this.view();
    return this.copy()
      .mixBarLabelTemplate.replace('{multiPct}', mixPct(v, 'multiFamily'))
      .replace('{semiPct}', mixPct(v, 'semiDuplex'))
      .replace('{singlePct}', mixPct(v, 'singleDetached'));
  }

  toggleFaq(index: number): void {
    this.openFaq = this.openFaq === index ? null : index;
  }

  formatCad(value: number): string {
    return formatCad(value);
  }

  formatInt(value: number): string {
    return value.toLocaleString('en-CA');
  }
}
