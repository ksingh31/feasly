import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { switchMap, tap } from 'rxjs';
import type { EstimateInputs, PropertyRecord } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { StorePreviewEstimate, WizardState } from '../wizard';

type StageKey = 'validate' | 'fetch' | 'estimate';
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
 * the blurred pre-gate preview is stored in NGXS and the user moves to the
 * report; on failure an honest error with retry is shown.
 */
@Component({
  selector: 'app-analyzing-page',
  standalone: true,
  imports: [SiteFooterComponent, SiteNavComponent],
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
    this.seo.setPage({
      title: this.config.get('copy').seo.analyzingTitle,
      description: this.config.get('copy').seo.analyzing,
      path: '/estimate/analyzing',
    });
    this.runPipeline();
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
    this.stages = [
      { key: 'validate', label: this.copy.stageValidate, state: 'pending' },
      { key: 'fetch', label: this.copy.stageFetch, state: 'pending' },
      { key: 'estimate', label: this.copy.stageEstimate, state: 'pending' },
    ];
    const property = this.store.selectSnapshot(WizardState.property);
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
        tap({
          next: () => {
            this.setStage('fetch', 'done');
            this.setStage('estimate', 'active');
          },
          error: () => this.failStage('fetch'),
        }),
        switchMap((fresh) =>
          this.api
            .getPreviewEstimate({ addressKey: fresh.addressKey, ...inputs })
            .pipe(tap({ error: () => this.failStage('estimate') })),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (preview) => {
          this.setStage('estimate', 'done');
          this.store.dispatch(new StorePreviewEstimate(preview));
          void this.router.navigate(['/estimate/report']);
        },
        error: () => {
          this.failed = true;
        },
      });
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
