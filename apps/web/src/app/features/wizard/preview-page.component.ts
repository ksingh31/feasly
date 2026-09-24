import { Component, computed, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
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
 * card) plus the chosen sqft/tier. Blurred (CSS-only placeholders, lock
 * note): build cost range and total project range — the API contract
 * (`PreviewEstimateResponse`) types every figure as `{ blurred: true }`,
 * so rendering a real dollar figure here is a compile error.
 *
 * The one "Unlock" CTA in the flow routes to the lead gate; "← Back to
 * details" returns to S3 with wizard state intact (NGXS storage plugin).
 * Loads the blurred preview through the shared ReportState — this component
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
  protected readonly preview = this.store.selectSignal(ReportState.preview);
  protected readonly status = this.store.selectSignal(ReportState.status);

  protected readonly loading = computed(() => this.status() === 'loading' && this.preview() === null);
  protected readonly ready = computed(() => this.status() === 'ready' && this.preview() !== null);
  /** Full-page error card only when nothing loaded yet. */
  protected readonly loadFailed = computed(() => this.status() === 'error' && this.preview() === null);

  ngOnInit(): void {
    this.seo.setPage({
      title: this.config.get('copy').seo.previewTitle,
      description: this.config.get('copy').seo.preview,
      path: '/estimate/preview',
    });
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
