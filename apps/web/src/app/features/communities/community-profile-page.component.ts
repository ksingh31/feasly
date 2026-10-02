import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import type { CommunityProfileCopy, CommunityProfileView, DwellingBucket } from '@feasly/contracts';

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
