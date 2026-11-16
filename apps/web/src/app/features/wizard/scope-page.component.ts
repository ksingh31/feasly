import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { catchError, of } from 'rxjs';
import type {
  BasementOption,
  BuildingForm,
  FinishTier,
  GarageOption,
  ZoningDistrictsResponse,
} from '@feasly/contracts';
import { API_SERVICE } from '../../core/api';
import {
  buildingFormChoice,
  requestBuildingForm,
  type BuildingFormOption,
} from '../../core/utils/building-form-choice';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { ChooseProjectType, GoToStep, UpdateInputs, WizardState, type ProjectType } from '../wizard';
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
 * #689: under New Build, "What do you want to build?" lists the building
 * forms the lot's district typically allows, from the API's zoning
 * catalogue. Forms the engine estimates (`estimableBuildingForms`) are
 * selectable and priced; every other allowed form shows "Allowed here,
 * estimate coming soon" and, when picked, a waitlist tagged with the form,
 * district and community instead of the CTA. Unknown / Direct Control
 * districts — or a catalogue that fails to load — fail open: the estimable
 * forms only, nothing blocked, and the request names no form. This
 * component names no district or form; it only renders what the API says.
 */
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
  private readonly api = inject(API_SERVICE);

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

  /**
   * #689: the zoning catalogue. Null while loading and when the call fails —
   * the choice is then hidden and the estimate runs as before (fail open).
   * `toSignal` unsubscribes when the component is destroyed.
   */
  private readonly catalogue = toSignal(
    this.api
      .getZoningDistricts()
      .pipe(catchError(() => of<ZoningDistrictsResponse | null>(null))),
    { initialValue: null },
  );
  /** #689: building forms for this lot (null = no catalogue, choice hidden). */
  protected readonly formChoice = computed(() =>
    buildingFormChoice(this.catalogue(), this.property()?.zoning),
  );
  /**
   * #689: a picked form the engine does not estimate yet. Component-local on
   * purpose — it is never stored in the wizard or sent with an estimate.
   */
  protected readonly interestForm = signal<BuildingForm | null>(null);
  /** #689: the choice, only while New Build is selected. */
  protected readonly newBuildFormChoice = computed(() =>
    this.projectType() === 'new-build' ? this.formChoice() : null,
  );
  /** #689: the "coming soon" form picked, only while New Build is selected. */
  protected readonly newBuildInterest = computed(() =>
    this.projectType() === 'new-build' ? this.interestForm() : null,
  );
  /** New-build scope inputs (sqft, tier, garage, basement); hidden on a form waitlist (#689). */
  protected readonly showScopeInputs = computed(
    () => this.projectType() === 'new-build' && this.newBuildInterest() == null,
  );
  /** #689: the form the estimate will be for (null on fail-open lots: none sent). */
  private readonly estimateForm = computed(
    () => requestBuildingForm(this.formChoice(), this.inputs().buildingForm) ?? null,
  );
  /** #689: the card shown as selected. */
  protected readonly selectedForm = computed<BuildingForm | null>(
    () =>
      this.interestForm() ??
      this.estimateForm() ??
      this.formChoice()?.options.find((o) => o.estimable)?.form ??
      null,
  );
  /** #689: the first estimable form, for the "estimate … instead" action. */
  protected readonly firstEstimable = computed(
    () => this.formChoice()?.options.find((o) => o.estimable)?.form ?? null,
  );
  /** #689: the covered-district hint with the district code filled in. */
  protected readonly formHint = computed(() => {
    const choice = this.formChoice();
    if (!choice) return '';
    return choice.status === 'covered'
      ? this.copy.scopeBuildingFormHint.replaceAll('{district}', choice.districtCode)
      : this.copy.scopeBuildingFormFailOpenHint;
  });

  ngOnInit(): void {
    this.seo.setForRoute('estimate/scope');
    // New builds are the marketed path: preselect New Build when no choice
    // exists yet, so the scope step never opens on Renovation. A stored
    // choice (refresh/back, marketing preselect) is always respected.
    if (this.projectType() == null) {
      this.store.dispatch(new ChooseProjectType('new-build'));
    }
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

  /** #689: display name for a form (config copy; falls back to the id). */
  protected formName(form: BuildingForm | null): string {
    if (form == null) return '';
    return this.copy.buildingForms[form]?.name ?? form;
  }

  /** #689: blurb for a form card (config copy; empty when missing). */
  protected formBlurb(form: BuildingForm): string {
    return this.copy.buildingForms[form]?.blurb ?? '';
  }

  /** #689: "Estimate a … home instead" with the first estimable form's name. */
  protected get formBackCta(): string {
    return this.copy.scopeBuildingFormBackCta.replaceAll(
      '{form}',
      this.formName(this.firstEstimable()).toLowerCase(),
    );
  }

  /**
   * #689: building-form card. An estimable form is stored in NGXS (it rides
   * on the estimate request); any other form only opens its waitlist.
   */
  chooseBuildingForm(option: BuildingFormOption): void {
    if (!option.estimable) {
      this.interestForm.set(option.form);
      return;
    }
    this.interestForm.set(null);
    if (this.formChoice()?.status === 'covered') {
      this.store.dispatch(new UpdateInputs({ buildingForm: option.form }));
    }
  }

  /** #689: radio-group arrow keys between the form cards. */
  onBuildingFormKeydown(event: KeyboardEvent): void {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const options = this.formChoice()?.options ?? [];
    if ((!forward && !backward) || options.length === 0) {
      return;
    }
    event.preventDefault();
    const current = options.findIndex((o) => o.form === this.selectedForm());
    const next = (current + (forward ? 1 : -1) + options.length) % options.length;
    this.chooseBuildingForm(options[next]);
    const target = event.currentTarget as HTMLElement | null;
    target?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  }

  /** #689: back from a form waitlist to the first estimable form. */
  backToEstimableForm(): void {
    const form = this.firstEstimable();
    const option = this.formChoice()?.options.find((o) => o.form === form);
    if (option) {
      this.chooseBuildingForm(option);
    }
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
    if (this.newBuildInterest() != null) {
      // #689: a form we don't estimate yet shows its waitlist, never the
      // CTA. Backstop only — the button is hidden on this path.
      return;
    }
    // #689: the form rides on the estimate request (none on fail-open lots,
    // so the API's single-detached path runs exactly as before).
    this.store.dispatch([
      new UpdateInputs({ buildingForm: this.estimateForm() ?? undefined }),
      new ChooseProjectType(type),
      new GoToStep(3),
    ]);
    // #507: no Details step — scope goes straight to the preview.
    void this.router.navigate(['/estimate/preview']);
  }
}
