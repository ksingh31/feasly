import { Component, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { FinishTier } from '@feasly/contracts';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import {
  ChooseProjectType,
  GoToStep,
  UpdateRenoInputs,
  WizardState,
  type RenoType,
} from '../wizard';
import {
  PropertyCardComponent,
  SiteFooterComponent,
  SiteNavComponent,
  WizardStepsComponent,
} from '../../shared/components';

/**
 * Reno scope-inputs step (RENO-03): renovation type, affected area, finishes.
 *
 * Five inputs max: (1) reno-type segmented control, (2) affected-area slider +
 * numeric input, (3) finish tier, (4) underpinning toggle (basement/combined
 * only). All state lives in NGXS `WizardState.renoInputs` (persisted via the
 * storage plugin). The CTA stays disabled until reno type + sqft + tier are
 * set. No dollar figures appear here — numbers surface later, blurred pre-gate.
 */
@Component({
  selector: 'app-reno-scope-page',
  standalone: true,
  imports: [
    PropertyCardComponent,
    RouterLink,
    SiteFooterComponent,
    SiteNavComponent,
    WizardStepsComponent,
  ],
  templateUrl: './reno-scope-page.component.html',
  styleUrls: ['./wizard-shell.scss', './reno-scope-page.component.scss'],
})
export class RenoScopePageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  protected readonly property = this.store.selectSignal(WizardState.property);
  protected readonly projectType = this.store.selectSignal(WizardState.projectType);
  protected readonly renoInputs = this.store.selectSignal(WizardState.renoInputs);
  /** Wizard tunables (config-owned): slider bounds never appear as literals. */
  protected readonly wizard = this.config.get('wizard');
  /** Reno scope copy (config-owned). */
  protected readonly copy = this.config.get('copy').wizard;
  /** Inline note shown when a numeric entry was clamped (cleared on next input). */
  protected readonly clampNote = signal<string | null>(null);

  ngOnInit(): void {
    this.seo.setForRoute('estimate/reno-scope');
    // Guard: this step only makes sense for renovations. If the user landed
    // here without picking a project type, send them back to the scope step.
    if (this.projectType() !== 'renovation') {
      this.store.dispatch(new GoToStep(2));
      void this.router.navigate(['/estimate/scope']);
    }
  }

  /** Reno-type card: stores the selection; underpinning clears automatically for non-basement types. */
  chooseRenoType(type: RenoType): void {
    // Clamp the stored affected area to the new type's cap: additions bill at
    // most 400 sq ft, so a value carried over from another type must not
    // persist above the cap (it would desync the slider/number inputs and
    // fail analyzing validation).
    const cap = type === 'addition' ? this.wizard.renoAdditionCap : this.wizard.renoSqftMax;
    const current = this.renoInputs().renoSqft;
    if (current > cap) {
      this.clampNote.set(this.copy.renoAdditionCapNote);
      this.store.dispatch(new UpdateRenoInputs({ renoType: type, renoSqft: cap }));
    } else {
      this.clampNote.set(null);
      this.store.dispatch(new UpdateRenoInputs({ renoType: type }));
    }
  }

  /**
   * Radio-group arrow keys: moves the selection between the reno-type cards.
   * Tab/Enter/Space keep working natively on the buttons.
   */
  onRenoTypeKeydown(event: KeyboardEvent): void {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) {
      return;
    }
    event.preventDefault();
    const ids = this.copy.renoTypes.map((t) => t.id);
    const current = ids.indexOf(this.renoInputs().renoType as RenoType);
    const next = (current + (forward ? 1 : -1) + ids.length) % ids.length;
    this.chooseRenoType(ids[next]);
  }

  /** Whether the underpinning toggle is shown (basement or combined only). */
  protected showsUnderpinning(): boolean {
    const t = this.renoInputs().renoType;
    return t === 'basement' || t === 'combined';
  }

  /** Effective sqft cap: additions bill at most 400 sq ft (RENO-01). */
  protected sqftCap(): number {
    return this.renoInputs().renoType === 'addition'
      ? this.wizard.renoAdditionCap
      : this.wizard.renoSqftMax;
  }

  /** Slider input: clamps to the effective range and stores the value. */
  onSqftSlider(event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    if (!Number.isFinite(value)) {
      return;
    }
    this.clampNote.set(null);
    const cap = this.sqftCap();
    const clamped = Math.min(cap, Math.max(this.wizard.renoSqftMin, Math.round(value)));
    this.store.dispatch(new UpdateRenoInputs({ renoSqft: clamped }));
  }

  /**
   * Numeric input (live keystrokes): commit finite values straight to the
   * store so the slider tracks typing. No clamping while typing — the CTA
   * stays disabled until the value is inside the valid range, and blur
   * (onSqftNumber) clamps with an inline note.
   */
  onSqftNumberInput(event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    if (!Number.isFinite(value)) {
      return;
    }
    this.clampNote.set(null);
    this.store.dispatch(new UpdateRenoInputs({ renoSqft: Math.round(value) }));
  }

  /**
   * Numeric input commit (blur/Enter): clamps to the effective range. Additions clamp at 400 with
   * the exact inline note (never a silent clamp); other out-of-range entries
   * show a generic adjustment note.
   */
  onSqftNumber(event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    if (!Number.isFinite(value)) {
      return;
    }
    const cap = this.sqftCap();
    const rounded = Math.round(value);
    if (rounded > cap) {
      this.clampNote.set(
        this.renoInputs().renoType === 'addition'
          ? this.copy.renoAdditionCapNote
          : this.copy.renoSqftClampNote,
      );
      this.store.dispatch(new UpdateRenoInputs({ renoSqft: cap }));
      return;
    }
    if (rounded < this.wizard.renoSqftMin) {
      this.clampNote.set(this.copy.renoSqftClampNote);
      this.store.dispatch(new UpdateRenoInputs({ renoSqft: this.wizard.renoSqftMin }));
      return;
    }
    this.clampNote.set(null);
    this.store.dispatch(new UpdateRenoInputs({ renoSqft: rounded }));
  }

  chooseTier(tier: FinishTier): void {
    this.store.dispatch(new UpdateRenoInputs({ tier }));
  }

  toggleUnderpinning(): void {
    this.store.dispatch(new UpdateRenoInputs({ underpinning: !this.renoInputs().underpinning }));
  }

  /**
   * CTA enablement: reno type + tier must be set AND the affected area must
   * be inside the valid range for the selected type. An out-of-range value
   * (e.g. typed but not yet clamped) keeps the CTA disabled so an invalid
   * estimate can never reach the analyzing pipeline.
   */
  protected canContinue(): boolean {
    const r = this.renoInputs();
    if (r.renoType == null || r.tier == null) {
      return false;
    }
    const cap = this.sqftCap();
    return (
      Number.isFinite(r.renoSqft) &&
      r.renoSqft >= this.wizard.renoSqftMin &&
      r.renoSqft <= cap
    );
  }

  goBack(): void {
    this.store.dispatch(new GoToStep(2));
    // The routerLink on the template anchor performs the navigation.
  }

  seePreview(): void {
    if (!this.canContinue()) {
      return;
    }
    // Reno estimates skip the new-build details step — the analyzing screen
    // reads renoInputs from NGXS when projectType is 'renovation'.
    this.store.dispatch([new ChooseProjectType('renovation'), new GoToStep(3)]);
    void this.router.navigate(['/estimate/analyzing']);
  }
}
