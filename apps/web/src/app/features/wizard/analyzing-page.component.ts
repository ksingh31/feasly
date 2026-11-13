import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { switchMap, tap, timeout } from 'rxjs';
import type { EstimateInputs, PreviewEstimateResponse, PropertyRecord } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { buildNewBuildRequest } from '../../core/api/build-estimate-request';
import { cachedPreviewFor, previewRequestKey } from '../../core/api/preview-cache';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent, WizardBackComponent } from '../../shared/components';
import { EmbedState } from '../embed/embed.state';
import { SetReportToken } from '../report/report.actions';
import { LeadState, StorePreviewEstimate, WizardState } from '../wizard';

type StageKey = 'validate' | 'fetch' | 'scope' | 'estimate' | 'preview';
type StageState = 'pending' | 'active' | 'done' | 'error';

interface PipelineStage {
  key: StageKey;
  label: string;
  state: StageState;
}

/**
 * Analyzing screen (FE-004): the estimate pipeline, shown honestly.
 *
 * Each stage resolves for real — validating the wizard inputs against the
 * config bounds, fetching the City property record over the API, then
 * running the estimate over the API. There is no timed or fake progress:
 * a stage flips to done only when its underlying work resolves. On success
 * the real-figures pre-gate preview is stored in NGXS (rendered blurred
 * until the lead gate unlocks), the report token is
 * established for the same-session lead (dev/mock unlock — see
 * ApiService.devTokenForLead), and the user moves to the report; on failure
 * an honest error with retry is shown. In production (no dev token) the
 * report page unlocks immediately from the submitted lead instead
 * (Karan directive 2026-09-27) — the magic-link email is return-access for
 * other devices, not the unlock key for this session.
 *
 * Reuse, don't re-mint (#489): the real API mints a new estimateId on every
 * preview call. When the wizard slice already holds the preview for exactly
 * this request (the preview step or the gate produced it, and the lead is
 * attached to it), the fetch + estimate stages resolve from that cached
 * result — no second property lookup, no new estimate row — so the report
 * shows the same estimate the lead points at.
 */
@Component({
  selector: 'app-analyzing-page',
  standalone: true,
  imports: [SiteFooterComponent, SiteNavComponent, WizardBackComponent],
  templateUrl: './analyzing-page.component.html',
  styleUrls: ['./wizard-shell.scss', './analyzing-page.component.scss'],
})
export class AnalyzingPageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly api = inject(API_SERVICE);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);

  /** Analyzing copy (config-owned). */
  protected readonly copy = this.config.get('copy').analyzing;

  /**
   * Pipeline state lives in signals, not plain fields: the app runs zoneless
   * change detection, so a plain-field write inside an HTTP callback (notably
   * the error path) never re-renders — the screen would sit on "In progress"
   * forever with no error and no retry (#483).
   */
  protected readonly stages = signal<PipelineStage[]>([]);
  protected readonly failed = signal(false);

  ngOnInit(): void {
    this.seo.setForRoute('estimate/analyzing');
    // Renovation is out of launch scope (Karan 2026-09-27): reno users get
    // the designed coming-soon page, never the analyzing pipeline — no
    // spinner, no 503 error card. This redirect also covers deep links and
    // back-button landings; reno-scope navigates to coming-soon directly.
    if (this.store.selectSnapshot(WizardState.projectType) === 'renovation') {
      void this.router.navigate(['/estimate/reno-coming-soon']);
      return;
    }
    // Belt and braces behind wizardScopeGuard: with no property there is no
    // pipeline to run — bounce to the wizard instead of a stuck loader.
    if (!this.store.selectSnapshot(WizardState.property)) {
      void this.router.navigate(['/']);
      return;
    }
    this.runPipeline();
  }

  /** Back link target: reno returns to the reno scope step, new-build to scope. */
  protected backLink(): string {
    return this.store.selectSnapshot(WizardState.projectType) === 'renovation'
      ? '/estimate/reno-scope'
      : '/estimate/scope';
  }

  /** Screen-reader status word for a stage. */
  stageStatus(stage: PipelineStage): string {
    switch (stage.state) {
      case 'active':
        return this.copy.statusActive;
      case 'done':
        return this.copy.statusDone;
      case 'error':
        return this.copy.statusError;
      default:
        return this.copy.statusPending;
    }
  }

  retry(): void {
    this.runPipeline();
  }

  private runPipeline(): void {
    this.failed.set(false);
    // Renovation never reaches this pipeline: ngOnInit redirects reno to the
    // coming-soon page (Karan 2026-09-27, reno out of launch scope).
    this.stages.set([
      { key: 'validate', label: this.copy.stageValidate, state: 'pending' },
      { key: 'fetch', label: this.copy.stageFetch, state: 'pending' },
      { key: 'estimate', label: this.copy.stageEstimate, state: 'pending' },
    ]);

    const property = this.store.selectSnapshot(WizardState.property);
    this.runNewBuildPipeline(property);
  }

  /** New-build pipeline: 3 stages (unchanged from FE-004). */
  private runNewBuildPipeline(property: PropertyRecord | null): void {
    const inputs = this.store.selectSnapshot(WizardState.inputs);

    // Stage 1 — validate the inputs for real (config bounds, known tier).
    this.setStage('validate', 'active');
    if (!property || !this.inputsValid(property, inputs)) {
      this.failStage('validate');
      return;
    }
    this.setStage('validate', 'done');

    const tenantKey = this.store.selectSnapshot(EmbedState.tenantKey) ?? null;

    // Stages 2+3 already resolved: the preview for this exact request was
    // computed moments ago and the lead is attached to its estimateId.
    const cached = cachedPreviewFor(
      this.store.selectSnapshot(WizardState.previewCache),
      buildNewBuildRequest(property, inputs),
      tenantKey,
    );
    if (cached) {
      this.setStage('fetch', 'done');
      this.setStage('estimate', 'done');
      this.finish(cached, null, tenantKey);
      return;
    }

    // Stages 2+3 — real API work: refresh the property record, then estimate.
    this.setStage('fetch', 'active');
    let requestKey: string | null = null;
    this.api
      .getProperty(property.addressKey)
      .pipe(
        // A stalled API call must fail honestly instead of hanging the
        // pipeline on "In progress" forever.
        timeout(this.config.get('timings').analyzingTimeoutMs),
        tap({
          next: () => {
            this.setStage('fetch', 'done');
            this.setStage('estimate', 'active');
          },
          error: () => this.failStage('fetch'),
        }),
        switchMap((fresh) => {
          // Nested request shape mirrors the live backend's
          // NewBuildRequestSchema: { property, scope }. A flat body 400s.
          const request = buildNewBuildRequest(fresh, inputs);
          requestKey = previewRequestKey(request);
          return this.api
            .getPreviewEstimate(tenantKey ? { ...request, tenantKey } : request)
            .pipe(
              timeout(this.config.get('timings').analyzingTimeoutMs),
              tap({ error: () => this.failStage('estimate') }),
            );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (preview) => {
          this.setStage('estimate', 'done');
          this.finish(preview, requestKey, tenantKey);
        },
        error: () => {
          this.failed.set(true);
        },
      });
  }

  /**
   * Stores the preview and moves to the report. `requestKey` null keeps the
   * cache identity already stored (the cached path re-stores the same entry).
   */
  private finish(
    preview: PreviewEstimateResponse,
    requestKey: string | null,
    tenantKey: string | null,
  ): void {
    // Same-session unlock: the lead was submitted moments ago in this
    // session. In dev/mock the token the "email" carried is available via
    // the optional devTokenForLead hook, so the report token is
    // established here and the report lands unlocked. Against the real
    // backend the hook is undefined — the report page then unlocks
    // immediately from the submitted lead itself (Karan directive
    // 2026-09-27; the magic-link email becomes return-access for other
    // devices, and the token-gated extras still need it).
    const leadId = this.store.selectSnapshot(LeadState.leadId);
    const devToken = leadId ? this.api.devTokenForLead?.(leadId) : undefined;
    const key = requestKey ?? this.store.selectSnapshot(WizardState.previewCache).key;
    const actions: Array<StorePreviewEstimate | SetReportToken> = [
      new StorePreviewEstimate(preview, key, tenantKey),
    ];
    if (devToken) {
      actions.push(new SetReportToken(devToken));
    }
    this.store.dispatch(actions);
    void this.router.navigate(['/estimate/report']);
  }

  /** Genuine input checks — the same bounds the scope step enforces. */
  private inputsValid(property: PropertyRecord, inputs: EstimateInputs): boolean {
    if (property.addressKey.trim() === '') {
      return false;
    }
    const wizard = this.config.get('wizard');
    if (!Number.isFinite(inputs.sqft) || inputs.sqft < wizard.sqftMin || inputs.sqft > wizard.sqftMax) {
      return false;
    }
    const knownTier = this.config
      .get('copy')
      .wizard.scopeTiers.some((tier) => tier.id === inputs.tier);
    return knownTier;
  }

  private setStage(key: StageKey, state: StageState): void {
    // Signal update: schedules a zoneless re-render from any callback.
    this.stages.update((stages) => stages.map((s) => (s.key === key ? { ...s, state } : s)));
  }

  private failStage(key: StageKey): void {
    this.setStage(key, 'error');
    this.failed.set(true);
  }
}
