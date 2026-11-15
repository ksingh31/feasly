import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { CostRange } from '@feasly/contracts';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import {
  PropertyCardComponent,
  SiteFooterComponent,
  SiteNavComponent,
  WizardBackComponent,
  WizardStepsComponent,
} from '../../shared/components';
import { formatCompactCad, formatCompactRange } from '../../shared/utils/money';
import { EmbedState } from '../embed/embed.state';
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
 * #507 (M3): the Details step is gone. The property card and inputs recap
 * collapse into one chip ("address · 2,200 sq ft · Standard · Edit") so the
 * locked totals and the CTA sit in the first 390×844 viewport; the full
 * property card follows below the CTA. Edit and "← Back to scope" return to
 * the scope step with wizard state intact (NGXS storage plugin). Step
 * indicator: 3 of Address → Your home → Estimate.
 *
 * The one "Unlock" CTA in the flow routes to the lead gate.
 * Loads the preview through the shared ReportState — this component
 * never calls the API directly.
 */
@Component({
  selector: 'app-preview-page',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    PropertyCardComponent,
    RouterLink,
    SiteFooterComponent,
    SiteNavComponent,
    WizardBackComponent,
    WizardStepsComponent,
  ],
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
  /** Tier and reno-type display names live with the wizard copy — reused, never duplicated. */
  protected readonly wizardCopy = this.config.get('copy').wizard;

  protected readonly property = this.store.selectSignal(WizardState.property);
  protected readonly inputs = this.store.selectSignal(WizardState.inputs);
  protected readonly projectType = this.store.selectSignal(WizardState.projectType);
  protected readonly renoInputs = this.store.selectSignal(WizardState.renoInputs);
  protected readonly preview = this.store.selectSignal(ReportState.preview);
  protected readonly status = this.store.selectSignal(ReportState.status);
  /** Failure classification: 'validation' when the API rejected the request. */
  protected readonly reportError = this.store.selectSignal(ReportState.error);

  /** True when this is a renovation preview (vs new-build). */
  protected readonly isReno = computed(() => this.projectType() === 'renovation');

  /** Reno type display label (from wizard copy renoTypes). */
  protected readonly renoTypeLabel = computed(() => {
    const renoType = this.renoInputs().renoType;
    if (!renoType) return '';
    return this.wizardCopy.renoTypes.find((t) => t.id === renoType)?.name ?? renoType;
  });

  /** "2,200 sq ft" — unit from config copy. */
  private formatSqft(sqft: number): string {
    return [sqft.toLocaleString('en-CA'), this.copy.recapSqftUnit].join(' ');
  }

  /** Tier display name (config-owned; falls back to the id). */
  private tierName(tier: string): string {
    return this.wizardCopy.scopeTiers.find((t) => t.id === tier)?.name ?? tier;
  }

  /**
   * Facts half of the one-line recap chip (#507): " · 2,200 sq ft · Standard",
   * with the renovation type first for reno. The address renders in its own
   * span so only the address truncates on narrow screens — size and tier
   * always stay visible. Display formatting only — no math.
   */
  protected readonly recapFacts = computed(() => {
    const parts: string[] = [];
    if (this.isReno()) {
      const reno = this.renoInputs();
      const type = this.renoTypeLabel();
      if (type) parts.push(type);
      parts.push(this.formatSqft(reno.renoSqft), this.tierName(reno.tier));
    } else {
      const inputs = this.inputs();
      parts.push(this.formatSqft(inputs.sqft), this.tierName(inputs.tier));
    }
    return parts.map((part) => ` · ${part}`).join('');
  });

  /** Edit / back target: the scope step the inputs came from. */
  protected readonly editLink = computed(() => (this.isReno() ? '/estimate/reno-scope' : '/estimate/scope'));

  protected readonly loading = computed(() => this.status() === 'loading' && this.preview() === null);
  protected readonly ready = computed(() => this.status() === 'ready' && this.preview() !== null);

  /** Real computed figures from the pre-gate preview — rendered blurred. */
  protected readonly previewFigures = computed(() => this.preview()?.figures ?? null);

  /** Blurred pre-gate range, rounded: "$3.24M – $3.39M" / "$608,000 – $735,000" (#504). */
  protected previewRange(range: CostRange): string {
    return formatCompactRange(range);
  }

  /** Blurred secondary base figure, e.g. "$3.31M" (#504). */
  protected formatCompact(value: number): string {
    return formatCompactCad(value);
  }
  /** Full-page error card only when nothing loaded yet. */
  protected readonly loadFailed = computed(() => this.status() === 'error' && this.preview() === null);

  /**
   * True when the API rejected the request (e.g. assessed value out of
   * range). Retry cannot succeed — the UI explains the problem instead.
   * Lot size NEVER blocks (Karan, 2026-09-28): the engine prices any lot.
   */
  protected readonly isValidationError = computed(() => this.loadFailed() && this.reportError() === 'validation');

  /**
   * Buyer-grade explanation of a validation failure. Never renders the raw
   * API text — the generic message covers every validation case.
   */
  protected validationMessage(): string {
    return this.copy.validationGenericBody;
  }

  ngOnInit(): void {
    this.seo.setForRoute('estimate/preview');
    // Runs on every visit so the preview always reflects the current
    // scope inputs (e.g. after an Edit round-trip). An unchanged
    // request reuses the cached preview instead of minting a new estimate
    // (#489) — the gate attaches the lead to that same estimateId.
    this.store.dispatch(new LoadPreview(this.tenantKey()));
  }

  protected retry(): void {
    this.store.dispatch(new LoadPreview(this.tenantKey()));
  }

  /** EMB-03: embed tenant for attribution of the minted estimate (null outside an embed). */
  private tenantKey(): string | null {
    return this.store.selectSnapshot(EmbedState.tenantKey) ?? null;
  }

  /**
   * Back to the address step after a validation failure: the user needs a
   * different property, so the wizard-step bookkeeping resets to step 1
   * (the routerLink on the template anchor performs the navigation).
   */
  protected editInputs(): void {
    this.store.dispatch(new GoToStep(2));
  }

  protected backToAddress(): void {
    this.store.dispatch(new GoToStep(1));
  }
}
