import { Component, inject, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { FinishTier } from '@feasly/contracts';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { ChooseProjectType, GoToStep, UpdateInputs, WizardState, type ProjectType } from '../wizard';
import { PropertyCardComponent, SiteFooterComponent, SiteNavComponent, WizardStepsComponent } from '../../shared/components';

/**
 * S2 scope step (FE-2, RENO-02): project type + scope inputs.
 *
 * The step opens with two enabled project-type cards — New Build and
 * Renovation (no "coming soon"). The selection writes straight into the NGXS
 * wizard store (persisted via the storage plugin, so a refresh or a trip
 * back restores it) and decides what follows: new builds keep the living-area
 * slider + finish tier sections below; renovations get a note and continue
 * to the reno scope-inputs step. The CTA stays disabled until a type is
 * chosen. No dollar figures appear on this step: the estimate numbers
 * surface later, blurred pre-gate.
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
  /** Selected project type (null until the user picks a card). */
  protected readonly projectType = this.store.selectSignal(WizardState.projectType);
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

  /** Project-type card: stores the selection in NGXS (persisted). */
  chooseProjectType(type: ProjectType): void {
    this.store.dispatch(new ChooseProjectType(type));
  }

  /**
   * Radio-group arrow keys: moves the selection between the cards.
   * Tab/Enter/Space keep working natively on the buttons.
   */
  onProjectTypeKeydown(event: KeyboardEvent): void {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) {
      return;
    }
    event.preventDefault();
    const ids = this.copy.scopeProjectTypes.map((t) => t.id);
    const current = ids.indexOf(this.projectType() as ProjectType);
    const next = (current + (forward ? 1 : -1) + ids.length) % ids.length;
    this.chooseProjectType(ids[next]);
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
    const type = this.projectType();
    if (type == null) {
      return;
    }
    if (type === 'renovation') {
      // Reno scope inputs live on their own step (RENO-03); the step
      // indicator stays on "2 Scope". Until RENO-03 lands this route serves
      // an explicit placeholder — never a dead end.
      this.store.dispatch([new ChooseProjectType(type), new GoToStep(2)]);
      void this.router.navigate(['/estimate/reno-scope']);
      return;
    }
    this.store.dispatch([new ChooseProjectType(type), new GoToStep(3)]);
    void this.router.navigate(['/estimate/details']);
  }
}
