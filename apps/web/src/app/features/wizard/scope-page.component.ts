import { Component, inject, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { FinishTier } from '@feasly/contracts';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { ChooseProjectType, GoToStep, UpdateInputs, WizardState } from '../wizard';
import { PropertyCardComponent, SiteFooterComponent, SiteNavComponent, WizardStepsComponent } from '../../shared/components';

/**
 * S2 scope step (FE-2): build size + finish tier.
 *
 * The sqft slider always carries a value (config-seeded default, clamped to
 * the configured range); the tier defaults to Standard. Both write straight
 * into the NGXS wizard store — persisted via the storage plugin, so a refresh
 * keeps the selections. No dollar figures appear on this step: the estimate
 * numbers surface later, blurred pre-gate.
 *
 * M1 is new-build only, so continuing implies the new-build project type and
 * lands on the review step (S3), whose disabled "See My Preview" CTA is the
 * placeholder for the lead-gate story.
 */
@Component({
  selector: 'app-scope-page',
  standalone: true,
  imports: [
    PropertyCardComponent,
    RouterLink,
    SiteFooterComponent,
    SiteNavComponent,
    WizardStepsComponent,
  ],
  templateUrl: './scope-page.component.html',
  styleUrls: ['./wizard-shell.scss', './scope-page.component.scss'],
})
export class ScopePageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  protected readonly property = this.store.selectSignal(WizardState.property);
  protected readonly inputs = this.store.selectSignal(WizardState.inputs);
  /** Wizard tunables (config-owned): slider bounds never appear as literals. */
  protected readonly wizard = this.config.get('wizard');
  /** Scope-step copy (config-owned). */
  protected readonly copy = this.config.get('copy').wizard;

  ngOnInit(): void {
    this.seo.setPage({
      title: this.config.get('copy').seo.scopeTitle,
      description: this.config.get('copy').seo.scope,
      path: '/estimate/scope',
    });
  }

  /** Slider input: clamps to the configured range and stores the value. */
  onSqftInput(event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    if (!Number.isFinite(value)) {
      return;
    }
    const { sqftMin, sqftMax } = this.wizard;
    this.store.dispatch(
      new UpdateInputs({ sqft: Math.min(sqftMax, Math.max(sqftMin, Math.round(value))) }),
    );
  }

  chooseTier(tier: FinishTier): void {
    this.store.dispatch(new UpdateInputs({ tier }));
  }

  goBack(): void {
    this.store.dispatch(new GoToStep(1));
    void this.router.navigate(['/']);
  }

  seePreview(): void {
    this.store.dispatch([new ChooseProjectType('new-build'), new GoToStep(3)]);
    void this.router.navigate(['/estimate/details']);
  }
}
