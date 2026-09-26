import { Component, computed, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { CostRange } from '@feasly/contracts';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { PropertyCardComponent, SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { LoadPreview } from '../report/report.actions';
import { ReportState } from '../report/report.state';
import { GoToStep } from './wizard.actions';
import { WizardState } from './wizard.state';

/**
 * S5 estimate preview step — the single lead-gate point.
 *
 * Visible: address, community, lot size, zoning, assessed value (property
 * card) plus the chosen sqft/tier. The build cost range and total project
 * range render BLURRED (real computed figures behind CSS `filter: blur()`,
 * `aria-hidden`, unselectable) with the lock note — per Karan 2026-09-26,
 * blurred real digits replace the old animated shimmer bars. The blur is a
 * lead-capture nudge, not a security boundary.
 *
 * The one "Unlock" CTA in the flow routes to the lead gate; "← Back to
 * details" returns to S3 with wizard state intact (NGXS storage plugin).
 * Loads the preview through the shared ReportState — this component
 * never calls the API directly.
 */
@Component({
  selector: 'app-preview-page',
  standalone: true,
  imports: [PropertyCardComponent, RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './preview-page.component.html',
  styleUrls: ['./wizard-shell.scss', './preview-page.component.scss'],
})
export class PreviewPageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  /** Preview-step copy (config-owned). */
  protected readonly copy = this.config.get('copy').preview;
  /**
   * Figure labels, the locked note, the one "Unlock" CTA, and the
   * loading/error strings live with the report copy — reused, never
   * duplicated (the word "Unlock" has a single source in the flow).
   */
  protected readonly reportCopy = this.config.get('copy').report;
  /** Visible summary labels live with the wizard copy — reused, never duplicated. */
  protected readonly wizardCopy = this.config.get('copy').wizard;

  protected readonly property = this.store.selectSignal(WizardState.property);
  protected readonly inputs = this.store.selectSignal(WizardState.inputs);
  protected readonly projectType = this.store.selectSignal(WizardState.projectType);
  protected readonly renoInputs = this.store.selectSignal(WizardState.renoInputs);
  protected readonly preview = this.store.selectSignal(ReportState.preview);
  protected readonly status = this.store.selectSignal(ReportState.status);

  /** True when this is a renovation preview (vs new-build). */
  protected readonly isReno = computed(() => this.projectType() === 'renovation');

  /** Reno type display label (from wizard copy renoTypes). */
  protected readonly renoTypeLabel = computed(() => {
    const renoType = this.renoInputs().renoType;
    if (!renoType) return '';
    return this.wizardCopy.renoTypes.find((t) => t.id === renoType)?.name ?? renoType;
  });

  protected readonly loading = computed(() => this.status() === 'loading' && this.preview() === null);
  protected readonly ready = computed(() => this.status() === 'ready' && this.preview() !== null);

  /** Real computed figures from the pre-gate preview — rendered blurred. */
  protected readonly previewFigures = computed(() => this.preview()?.figures ?? null);

  /** Blurred pre-gate range, e.g. "$608,000 – $735,000". */
  protected previewRange(range: CostRange): string {
    return this.formatCad(range.low) + ' – ' + this.formatCad(range.high);
  }

  protected formatCad(value: number): string {
    return `$${Math.round(value).toLocaleString('en-CA')}`;
  }
  /** Full-page error card only when nothing loaded yet. */
  protected readonly loadFailed = computed(() => this.status() === 'error' && this.preview() === null);

  ngOnInit(): void {
    this.seo.setForRoute('estimate/preview');
    // Re-runs on every visit so the preview always reflects the current
    // details inputs (e.g. after "← Back to details" edits).
    this.store.dispatch(new LoadPreview());
  }

  protected retry(): void {
    this.store.dispatch(new LoadPreview());
  }

  /** Back to the details step: the routerLink navigates; this keeps the
   * wizard-step bookkeeping accurate (same pattern as the details page). */
  protected goBack(): void {
    this.store.dispatch(new GoToStep(3));
  }
}
