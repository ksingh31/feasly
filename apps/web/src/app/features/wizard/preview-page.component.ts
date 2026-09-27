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
  /** Failure classification: 'validation' when the API rejected the request. */
  protected readonly reportError = this.store.selectSignal(ReportState.error);
  /** API error detail (e.g. the validation message) — translated, never verbatim. */
  protected readonly errorDetail = this.store.selectSignal(ReportState.errorDetail);

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
  /** Display name for the chosen garage (config-owned; falls back to the id). */
  protected garageName(): string {
    const garage = this.inputs().garage;
    return this.wizardCopy.scopeGarages.find((g) => g.id === garage)?.name ?? garage;
  }

  /** Display name for the chosen basement (config-owned; falls back to the id). */
  protected basementName(): string {
    const basement = this.inputs().basement;
    return this.wizardCopy.scopeBasements.find((b) => b.id === basement)?.name ?? basement;
  }

  /** Full-page error card only when nothing loaded yet. */
  protected readonly loadFailed = computed(() => this.status() === 'error' && this.preview() === null);

  /**
   * True when the API rejected the request (e.g. lot size out of range).
   * Retry cannot succeed — the UI explains the problem instead.
   */
  protected readonly isValidationError = computed(() => this.loadFailed() && this.reportError() === 'validation');

  /**
   * Buyer-grade explanation of a validation failure. Uses the API's error
   * detail when it matches the known lot-size shape; falls back to the
   * generic message otherwise. Never renders the raw API text.
   */
  protected validationMessage(): string {
    const detail = this.errorDetail() ?? '';
    const lotMatch = detail.match(/lotSizeSqft\s+(\d+)\s+outside\s*\[(\d+)\s*,\s*(\d+)\]/);
    if (lotMatch) {
      const [, lot, min, max] = lotMatch;
      const fmt = (n: string): string => Number(n).toLocaleString('en-CA');
      return this.copy.validationLotSizeBody
        .replace('{lot}', fmt(lot))
        .replace('{min}', fmt(min))
        .replace('{max}', fmt(max));
    }
    return this.copy.validationGenericBody;
  }

  ngOnInit(): void {
    this.seo.setForRoute('estimate/preview');
    // Re-runs on every visit so the preview always reflects the current
    // details inputs (e.g. after "← Back to details" edits).
    this.store.dispatch(new LoadPreview());
  }

  protected retry(): void {
    this.store.dispatch(new LoadPreview());
  }

  /**
   * Back to the address step after a validation failure: the user needs a
   * different property, so the wizard-step bookkeeping resets to step 1
   * (the routerLink on the template anchor performs the navigation).
   */
  protected backToAddress(): void {
    this.store.dispatch(new GoToStep(1));
  }

  /** Back to the details step: the routerLink navigates; this keeps the
   * wizard-step bookkeeping accurate (same pattern as the details page). */
  protected goBack(): void {
    this.store.dispatch(new GoToStep(3));
  }
}
