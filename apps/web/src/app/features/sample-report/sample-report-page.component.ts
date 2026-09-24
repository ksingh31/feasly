import { Component, OnInit, inject } from '@angular/core';
import type { CostRange, CostRow, FinishTier } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';

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
  'In your real report, switching tiers re-runs the estimate with the new finishes.';

export const SAMPLE_REPORT_ADJUST_NOTE =
  'In your real report, you can adjust the living area and re-run the estimate.';

/** The fictional dataset behind the sample page. All figures are invented and
 * visibly uncalibrated; `sample: true` marks the page for tests and templates. */
export interface SampleReportData {
  readonly sample: true;
  readonly address: string;
  readonly total: CostRange;
  readonly build: CostRange;
  readonly land: CostRange;
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
  total: range(512_000, 585_000, 668_000),
  build: range(402_000, 465_000, 538_000),
  land: range(148_000, 165_000, 189_000),
  rows: [
    { key: 'land', label: 'Land (assessed value)', range: range(148_000, 165_000, 189_000) },
    { key: 'site-prep', label: 'Site preparation & demolition', range: range(28_000, 35_000, 44_000) },
    { key: 'foundation', label: 'Foundation & concrete', range: range(42_000, 51_000, 62_000) },
    { key: 'framing', label: 'Framing & structure', range: range(68_000, 79_000, 92_000) },
    { key: 'exterior', label: 'Exterior envelope', range: range(45_000, 54_000, 65_000) },
    { key: 'interior', label: 'Interior finishes (Standard tier)', range: range(96_000, 112_000, 131_000) },
    { key: 'mechanical', label: 'Mechanical & electrical', range: range(52_000, 61_000, 72_000) },
  ],
  tier: 'standard',
  sqft: 2_200,
};

/**
 * Labelled sample report (story seo/09). Renders the full unlocked report
 * layout with fictional data so visitors can see what a Feasly report looks
 * like before handing over their email.
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

  /** Report copy (config-owned) — same labels as the real report. */
  protected readonly copy = this.config.get('copy').report;
  /** Tier names live with the wizard copy — reused, never duplicated. */
  protected readonly tierOptions = this.config.get('copy').wizard.scopeTiers;
  protected readonly narrativeDisclaimer = this.config.get('copy').narrativeDisclaimer;

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
