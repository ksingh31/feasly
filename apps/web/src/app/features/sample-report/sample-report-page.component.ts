import { Component, OnInit, inject } from '@angular/core';
import type { CostRange, CostRow, FinishTier } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { aggregateCostBuckets, type CostBucket } from '../../shared/cost-buckets';

/**
 * Fictional address for the sample report. It deliberately contains the word
 * "Sample" so it can never be mistaken for a real Calgary property — the spec
 * asserts it against a denylist of real addresses used in fixtures.
 */
export const SAMPLE_REPORT_ADDRESS = '1234 Sample Crescent NW, Calgary, AB';

/** Banner + disclaimer copy. Sample-page prose lives here (not in config):
 * it changes with the sample's editorial framing, not with deploy tuning. */
export const SAMPLE_REPORT_BANNER =
  'This is a fictional sample report. The address, figures, and breakdown below are made up ' +
  'for illustration only — they are not a real estimate for a real property.';

export const SAMPLE_REPORT_TIER_NOTE =
  'In your real report the finish tier is shown here for reference — the report always reflects the tier you picked in the wizard.';

export const SAMPLE_REPORT_ADJUST_NOTE =
  'In your real report, adjusting the living area updates every figure instantly — no re-run button.';

/** Notes for the inert action sections (never functional on the sample). */
export const SAMPLE_REPORT_SHARE_NOTE =
  'Disabled on this sample page — in your real report this emails your partner a link to your exact report.';

export const SAMPLE_REPORT_CALLBACK_NOTE =
  'Disabled on this sample page — in your real report you can request a call about your estimate.';

export const SAMPLE_REPORT_PDF_NOTE =
  'Disabled on this sample page — in your real report this downloads your report as a PDF.';

/**
 * Fictional narrative prose for the sample AI-summary section. It contains no
 * dollar figures and no neighbourhood claims — it only demonstrates the shape
 * of the section. Always rendered with an explicit "sample text" label.
 */
export const SAMPLE_REPORT_NARRATIVE = [
  'This is where your AI summary appears in a real report — a short, plain-language read of your estimate: what drives the total, where the budget goes, and what to confirm before you talk to a builder.',
  'Your real summary is written from your property\u2019s actual figures and never invents numbers. Nothing on this page is a real assessment.',
];

/** The fictional dataset behind the sample page. All figures are invented and
 * visibly uncalibrated; `sample: true` marks the page for tests and templates.
 *
 * Shape mirrors the post-consumer/04 report: land is a FIXED figure (never a
 * range), and the trade rows aggregate into exactly three buckets via the
 * shared `aggregateCostBuckets` helper — the same bucketing the real report
 * uses. Row bases sum to the build base; total = build + land.
 */
export interface SampleReportData {
  readonly sample: true;
  readonly address: string;
  readonly total: CostRange;
  readonly build: CostRange;
  /** Fixed City-assessed land figure — a single number, not a range. */
  readonly landValue: number;
  readonly rows: readonly CostRow[];
  readonly tier: FinishTier;
  readonly sqft: number;
}

function range(low: number, base: number, high: number): CostRange {
  return { low, base, high };
}

export const SAMPLE_REPORT_DATA: SampleReportData = {
  sample: true,
  address: SAMPLE_REPORT_ADDRESS,
  total: range(561_000, 635_000, 727_000),
  build: range(396_000, 470_000, 562_000),
  landValue: 165_000,
  rows: [
    { key: 'site', label: 'Site preparation', range: range(28_000, 35_000, 44_000) },
    { key: 'foundation', label: 'Foundation & concrete', range: range(42_000, 51_000, 62_000) },
    { key: 'framing', label: 'Framing & structure', range: range(68_000, 79_000, 92_000) },
    { key: 'envelope', label: 'Exterior envelope', range: range(45_000, 54_000, 65_000) },
    { key: 'interior', label: 'Interior finishes (Standard tier)', range: range(96_000, 112_000, 131_000) },
    { key: 'mechanical', label: 'Mechanical & electrical', range: range(52_000, 61_000, 72_000) },
    { key: 'soft', label: 'Design & permits', range: range(30_000, 36_000, 44_000) },
    { key: 'contingency', label: 'Contingency', range: range(35_000, 42_000, 52_000) },
  ],
  tier: 'standard',
  sqft: 2_200,
};

/**
 * Labelled sample report (story seo/09). Renders the full unlocked report
 * layout with fictional data so visitors can see what a Feasly report looks
 * like before handing over their email. Mirrors the post-consumer/04 report
 * design: one hero total + planning range, fixed land figure, exactly three
 * cost buckets, display-only finish tier, always-visible (inert) stepper,
 * AI-summary section, next steps, and inert share/callback/PDF sections.
 *
 * Hard guarantees (asserted by specs):
 * - `sample: true` and an unmissable SAMPLE watermark on every viewport.
 * - No store, no API service, no forms: nothing is gated, emailed, persisted,
 *   and no conversion event can fire — this component is pure presentation.
 * - `noindex` via the route's `data` + robotsGuard; excluded from sitemap
 *   parity concerns by being listed explicitly in sitemap.xml.
 */
@Component({
  selector: 'app-sample-report-page',
  standalone: true,
  imports: [SiteNavComponent, SiteFooterComponent],
  templateUrl: './sample-report-page.component.html',
  styleUrls: [
    '../wizard/wizard-shell.scss',
    '../report/report-page.component.scss',
    './sample-report-page.component.scss',
  ],
})
export class SampleReportPageComponent implements OnInit {
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  /** Always true — the fictional-sample marker. */
  protected readonly sample = true as const;
  protected readonly data = SAMPLE_REPORT_DATA;
  protected readonly banner = SAMPLE_REPORT_BANNER;
  protected readonly tierNote = SAMPLE_REPORT_TIER_NOTE;
  protected readonly adjustNote = SAMPLE_REPORT_ADJUST_NOTE;
  protected readonly shareNote = SAMPLE_REPORT_SHARE_NOTE;
  protected readonly callbackNote = SAMPLE_REPORT_CALLBACK_NOTE;
  protected readonly pdfNote = SAMPLE_REPORT_PDF_NOTE;
  protected readonly narrativeParas = SAMPLE_REPORT_NARRATIVE;

  /** The 3-bucket breakdown — same shared helper as the real report. */
  protected readonly buckets: readonly CostBucket[] = aggregateCostBuckets(SAMPLE_REPORT_DATA.rows);

  /** Fictional per-sqft, derived from the fictional build base. */
  protected readonly perSqft = Math.round(SAMPLE_REPORT_DATA.build.base / SAMPLE_REPORT_DATA.sqft);

  /** Report copy (config-owned) — same labels as the real report. */
  protected readonly copy = this.config.get('copy').report;
  /** Tier names live with the wizard copy — reused, never duplicated. */
  protected readonly tierOptions = this.config.get('copy').wizard.scopeTiers;
  protected readonly narrativeDisclaimer = this.config.get('copy').narrativeDisclaimer;

  /** Display name of the fictional tier (report shows it display-only). */
  protected readonly tierName =
    this.tierOptions.find((t) => t.id === SAMPLE_REPORT_DATA.tier)?.name ?? 'Standard';

  /** aria-label for the stacked bucket bar (mirrors the real report). */
  protected bucketsAriaLabel(): string {
    return this.buckets.map((b) => `${b.label}: ${this.formatCad(b.range.base)}`).join(', ');
  }

  ngOnInit(): void {
    this.seo.setPage({
      title: this.config.get('copy').seo.sampleReportTitle,
      description: this.config.get('copy').seo.sampleReport,
      path: '/sample-report',
    });
  }

  protected formatCad(value: number): string {
    return `$${value.toLocaleString('en-CA')}`;
  }

  protected formatSqft(value: number): string {
    return value.toLocaleString('en-CA') + ' ' + this.copy.adjustUnit;
  }
}
