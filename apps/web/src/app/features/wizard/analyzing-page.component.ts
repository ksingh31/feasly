import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { switchMap, tap, timeout } from 'rxjs';
import type { EstimateInputs, PropertyRecord, RenoEstimateRequest } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { buildNewBuildRequest } from '../../core/api/build-estimate-request';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
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
 * an honest error with retry is shown.
 */
@Component({
  selector: 'app-analyzing-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
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

  protected stages: PipelineStage[] = [];
  protected failed = false;

  ngOnInit(): void {
    this.seo.setForRoute('estimate/analyzing');
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
    this.failed = false;
    const isReno = this.store.selectSnapshot(WizardState.projectType) === 'renovation';
    // RENO-04: reno uses 4 stages with reno-specific labels; new-build keeps 3.
    // Each label maps 1:1 to a real awaited operation — no fake timers.
    if (isReno) {
      this.stages = [
        { key: 'fetch', label: this.copy.stageFetchReno, state: 'pending' },
        { key: 'scope', label: this.copy.stageScopeReno, state: 'pending' },
        { key: 'estimate', label: this.copy.stageEstimateReno, state: 'pending' },
        { key: 'preview', label: this.copy.stagePreviewReno, state: 'pending' },
      ];
    } else {
      this.stages = [
        { key: 'validate', label: this.copy.stageValidate, state: 'pending' },
        { key: 'fetch', label: this.copy.stageFetch, state: 'pending' },
        { key: 'estimate', label: this.copy.stageEstimate, state: 'pending' },
      ];
    }

    const property = this.store.selectSnapshot(WizardState.property);

    if (isReno) {
      this.runRenoPipeline(property);
    } else {
      this.runNewBuildPipeline(property);
    }
  }

  /** Reno pipeline: 4 stages, each tied to a real awaited operation. */
  private runRenoPipeline(property: PropertyRecord | null): void {
    // Stage 1 — "Looking up property record…": real getProperty API call.
    this.setStage('fetch', 'active');
    if (!property) {
      this.failStage('fetch');
      return;
    }
    const renoInputs = this.store.selectSnapshot(WizardState.renoInputs);

    this.api
      .getProperty(property.addressKey)
      .pipe(
        // A stalled API call must fail honestly instead of hanging the
        // pipeline on "In progress" forever.
        timeout(this.config.get('timings').analyzingTimeoutMs),
        tap({
          next: () => {
            this.setStage('fetch', 'done');
            // Stage 2 — "Measuring the project scope…": real reno input validation.
            this.setStage('scope', 'active');
          },
          error: () => this.failStage('fetch'),
        }),
        switchMap((fresh) => {
          // Validate reno inputs against config bounds (real work, not a timer).
          if (!this.renoInputsValid(fresh, renoInputs)) {
            throw new Error('Invalid reno inputs');
          }
          this.setStage('scope', 'done');
          // Stage 3 — "Calculating renovation cost…": real estimate API call.
          this.setStage('estimate', 'active');
          const request = this.buildRenoRequest(fresh.addressKey, renoInputs);
          return this.api.getPreviewEstimate(request).pipe(
            timeout(this.config.get('timings').analyzingTimeoutMs),
            tap({ error: () => this.failStage('estimate') }),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (preview) => {
          this.setStage('estimate', 'done');
          // Stage 4 — "Generating your preview…": real NGXS dispatch + navigation.
          this.setStage('preview', 'active');
          const leadId = this.store.selectSnapshot(LeadState.leadId);
          const devToken = leadId ? this.api.devTokenForLead?.(leadId) : undefined;
          const actions: Array<StorePreviewEstimate | SetReportToken> = [
            new StorePreviewEstimate(preview),
          ];
          if (devToken) {
            actions.push(new SetReportToken(devToken));
          }
          this.store.dispatch(actions);
          this.setStage('preview', 'done');
          void this.router.navigate(['/estimate/report']);
        },
        error: () => {
          this.failed = true;
        },
      });
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

    // Stages 2+3 — real API work: refresh the property record, then estimate.
    this.setStage('fetch', 'active');
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
        switchMap((fresh) =>
          this.api
            // Nested request shape mirrors the live backend's
            // NewBuildRequestSchema: { property, scope }. A flat body 400s.
            .getPreviewEstimate(buildNewBuildRequest(fresh, inputs))
            .pipe(
              timeout(this.config.get('timings').analyzingTimeoutMs),
              tap({ error: () => this.failStage('estimate') }),
            ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (preview) => {
          this.setStage('estimate', 'done');
          // Same-session unlock: the lead was submitted moments ago in this
          // session. In dev/mock the token the "email" carried is available via
          // the optional devTokenForLead hook, so the report token is
          // established here and the report lands unlocked. Against the real
          // backend the hook is undefined and the report stays locked until the
          // user clicks the magic link in their email (the report page shows
          // the pending "check your email" state instead).
          const leadId = this.store.selectSnapshot(LeadState.leadId);
          const devToken = leadId ? this.api.devTokenForLead?.(leadId) : undefined;
          const actions: Array<StorePreviewEstimate | SetReportToken> = [
            new StorePreviewEstimate(preview),
          ];
          if (devToken) {
            actions.push(new SetReportToken(devToken));
          }
          this.store.dispatch(actions);
          void this.router.navigate(['/estimate/report']);
        },
        error: () => {
          this.failed = true;
        },
      });
  }

  /** Builds the reno estimate request from validated inputs. */
  private buildRenoRequest(
    addressKey: string,
    reno: { renoType: string | null; renoSqft: number; tier: string | null; underpinning: boolean },
  ): RenoEstimateRequest {
    return {
      projectType: 'renovation',
      addressKey,
      renoType: reno.renoType as RenoEstimateRequest['renoType'],
      renoSqft: reno.renoSqft,
      tier: reno.tier as RenoEstimateRequest['tier'],
      underpinning: reno.underpinning,
    };
  }

  /** Genuine reno input checks — the same bounds the reno scope step enforces. */
  private renoInputsValid(
    property: PropertyRecord,
    reno: { renoType: string | null; renoSqft: number; tier: string | null },
  ): boolean {
    if (property.addressKey.trim() === '') {
      return false;
    }
    if (reno.renoType == null || reno.tier == null) {
      return false;
    }
    const wizard = this.config.get('wizard');
    const cap = reno.renoType === 'addition' ? wizard.renoAdditionCap : wizard.renoSqftMax;
    if (!Number.isFinite(reno.renoSqft) || reno.renoSqft < wizard.renoSqftMin || reno.renoSqft > cap) {
      return false;
    }
    const knownTier = this.config
      .get('copy')
      .wizard.scopeTiers.some((tier) => tier.id === reno.tier);
    return knownTier;
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
    // Immutable update: a new array reference guarantees the @for block
    // re-evaluates even when a stage flips outside Angular's zone.
    this.stages = this.stages.map((s) => (s.key === key ? { ...s, state } : s));
  }

  private failStage(key: StageKey): void {
    this.setStage(key, 'error');
    this.failed = true;
  }
}
