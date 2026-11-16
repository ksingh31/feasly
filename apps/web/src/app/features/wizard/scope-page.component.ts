import { Component, computed, inject, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { AnalyticsEventName, BasementOption, FinishTier, GarageOption } from '@feasly/contracts';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { handleRadioGroupKeydown, radioTabIndex } from '../../core/utils/radio-group';
import { ChooseProjectType, GoToStep, MarkSteerApplied, UpdateInputs, WizardState, type ProjectType } from '../wizard';
import { AnalyticsService } from '../consent';
import {
  PropertyCardComponent,
  SiteFooterComponent,
  SiteNavComponent,
  SqftSliderComponent,
  OptionSelectorComponent,
  WizardBackComponent,
  WizardStepsComponent,
  WaitlistSignupComponent,
  type OptionCard,
  type TierOption,
} from '../../shared/components';

/**
 * S2 scope step (FE-2, RENO-02): project type + scope inputs.
 *
 * The step opens with two enabled project-type cards — New Build and
 * Renovation (no "coming soon"). New Build is preselected on first visit
 * (the marketed path — the step never opens on Renovation); a stored
 * choice (refresh/back, marketing preselect) is respected. The selection
 * writes straight into the NGXS wizard store (persisted via the storage
 * plugin, so a refresh or a trip back restores it) and decides what
 * follows: new builds keep the living-area slider + finish tier sections
 * below; renovations get a note and continue to the reno scope-inputs
 * step. No dollar figures appear on this step: the estimate numbers
 * surface later, blurred pre-gate.
 *
 * #520 (D-P4): while `features.renovationWaitlist` is on, the Renovation
 * card carries a "Coming soon" badge and picking it shows an email capture
 * plus a way back to New Build — the reno scope form (which ends on the
 * coming-soon page) is never reached, so nobody fills a form for nothing.
 *
 * #755: the API's home-age steer (`property.steer`, computed server-side
 * from the year built and the market threshold) decides what is offered
 * first. A redevelopment candidate opens on New Build; a younger home opens
 * on Renovation (card first, with a short reason) plus an "Estimate a new
 * build anyway" override; an unknown year opens with nothing selected. The
 * steer is applied once per property, so later explicit picks survive
 * refresh/back. Without a steer (older records, non-API sources) the
 * New Build preselect above applies unchanged. No rule lives here.
 */
/** #755: analytics event per steer offered on the scope step. */
const STEER_OFFERED_EVENT: Record<'new_build' | 'renovation' | 'none', AnalyticsEventName> = {
  new_build: 'steer_new_build_offered',
  renovation: 'steer_renovation_offered',
  none: 'steer_none_offered',
};

@Component({
  selector: 'app-scope-page',
  standalone: true,
  imports: [
    PropertyCardComponent,
    RouterLink,
    SiteFooterComponent,
    SiteNavComponent,
    SqftSliderComponent,
    OptionSelectorComponent,
    WizardBackComponent,
    WizardStepsComponent,
    WaitlistSignupComponent,
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
  /** #520: Renovation is "Coming soon" with a waitlist (deploy flag). */
  protected readonly renoWaitlist = this.config.get('features').renovationWaitlist;
  private readonly analytics = inject(AnalyticsService);

  /** #755: server-computed home-age steer for the selected property (absent = none). */
  protected readonly steer = computed(() => this.property()?.steer ?? null);
  /** #755: the API steers this home to renovation (so the override is offered). */
  protected readonly steeredToRenovation = computed(
    () => this.steer()?.recommendedProjectType === 'renovation',
  );
  /** #755: the override shows while a renovation-steered home is on Renovation. */
  protected readonly showSteerOverride = computed(
    () => this.steeredToRenovation() && this.projectType() === 'renovation',
  );
  /** #755: short reason under the cards, from config copy; null = no steering. */
  protected readonly steerReason = computed(() => {
    const steer = this.steer();
    const year = this.property()?.yearBuilt;
    if (!steer?.recommendedProjectType || year == null) {
      return null;
    }
    const template =
      steer.recommendedProjectType === 'renovation'
        ? this.copy.steerRenovationReason
        : this.copy.steerNewBuildReason;
    return template.replace('{year}', String(year));
  });
  /** #755: project-type cards in display order — the steered type first. */
  protected readonly projectTypes = computed(() => {
    const cards = this.copy.scopeProjectTypes;
    if (!this.steeredToRenovation()) {
      return cards;
    }
    return [...cards.filter((t) => t.id === 'renovation'), ...cards.filter((t) => t.id !== 'renovation')];
  });

  ngOnInit(): void {
    this.seo.setForRoute('estimate/scope');
    const property = this.property();
    const steer = property?.steer;
    if (property && steer) {
      // #755: apply the API's steer once per property, then respect picks.
      if (this.store.selectSnapshot(WizardState.steerAppliedFor) !== property.addressKey) {
        const offered = steer.recommendedProjectType;
        const actions: object[] = [new MarkSteerApplied(property.addressKey)];
        if (offered === 'new_build') {
          actions.push(new ChooseProjectType('new-build'));
        } else if (offered === 'renovation') {
          actions.push(new ChooseProjectType('renovation'));
        } else if (this.projectType() != null) {
          // Unknown year: show both equally — no carried-over selection.
          actions.push(new ChooseProjectType(null));
        }
        this.store.dispatch(actions);
        this.analytics.track(STEER_OFFERED_EVENT[offered ?? 'none']);
      }
      return;
    }
    // New builds are the marketed path: preselect New Build when no choice
    // exists yet, so the scope step never opens on Renovation. A stored
    // choice (refresh/back, marketing preselect) is always respected.
    if (this.projectType() == null) {
      this.store.dispatch(new ChooseProjectType('new-build'));
    }
  }

  /** Project-type card: stores the selection in NGXS (persisted). */
  chooseProjectType(type: ProjectType): void {
    if (type === 'new-build' && this.steeredToRenovation() && this.projectType() !== 'new-build') {
      // #755: a younger home's user chose a new build over the steer.
      this.analytics.track('steer_override_new_build');
    }
    this.store.dispatch(new ChooseProjectType(type));
  }

  /** #755: "Estimate a new build anyway" — continues on the normal new-build path. */
  overrideToNewBuild(): void {
    this.chooseProjectType('new-build');
  }

  /** Roving tabindex (#937): the checked project-type card is the group's one Tab stop. */
  projectTypeTabIndex(id: ProjectType): 0 | -1 {
    return radioTabIndex(this.projectTypeIds(), this.projectType(), id);
  }

  /** Radio-group keys: arrows/Home/End move focus and selection between the cards. */
  onProjectTypeKeydown(event: KeyboardEvent): void {
    handleRadioGroupKeydown(event, this.projectTypeIds(), this.projectType(), (id) =>
      this.chooseProjectType(id),
    );
  }

  private projectTypeIds(): ProjectType[] {
    return this.projectTypes().map((t) => t.id);
  }

  /** Slider input from the shared sqft component: stores the clamped value. */
  onSqftInput(value: number): void {
    this.store.dispatch(new UpdateInputs({ sqft: value }));
  }

  chooseTier(tier: FinishTier): void {
    this.store.dispatch(new UpdateInputs({ tier }));
  }

  /** Garage card: stores the selection in NGXS (persisted). */
  chooseGarage(garage: GarageOption): void {
    this.store.dispatch(new UpdateInputs({ garage }));
  }

  /** Basement card: stores the selection in NGXS (persisted). */
  chooseBasement(basement: BasementOption): void {
    this.store.dispatch(new UpdateInputs({ basement }));
  }

  /** Tier options for the shared selector (config-owned copy). */
  protected get tierOptions(): TierOption[] {
    return this.copy.scopeTiers.map((t) => ({ id: t.id as FinishTier, name: t.name, blurb: t.blurb }));
  }

  /** Garage options for the shared selector (config-owned copy). */
  protected get garageOptions(): OptionCard<GarageOption>[] {
    return this.copy.scopeGarages.map((g) => ({
      id: g.id as GarageOption,
      name: g.name,
      blurb: g.blurb,
    }));
  }

  /** Basement options for the shared selector (config-owned copy). */
  protected get basementOptions(): OptionCard<BasementOption>[] {
    return this.copy.scopeBasements.map((b) => ({
      id: b.id as BasementOption,
      name: b.name,
      blurb: b.blurb,
    }));
  }

  seePreview(): void {
    const type = this.projectType();
    if (type == null) {
      return;
    }
    if (type === 'renovation' && this.renoWaitlist) {
      // #520: the reno path is the waitlist on this step — never a form
      // that leads to "coming soon". The CTA is hidden; this is a backstop.
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
    // #507: no Details step — scope goes straight to the preview.
    void this.router.navigate(['/estimate/preview']);
  }
}
