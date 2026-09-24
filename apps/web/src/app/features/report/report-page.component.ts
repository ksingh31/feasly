import { Component, DestroyRef, OnInit, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { CallbackWindow, CostRange, CostRow, FinishTier } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { UpdateInputs, WizardState, LeadState } from '../wizard';
import { LoadPreview, ReviseReport, UnlockReport } from './report.actions';
import { ReportState } from './report.state';

/** One-shot form lifecycle for the share / callback forms. */
type FormStatus = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Breakdown rows with the land row first. The land row is synthesized only
 * when the API didn't send one — the real cost engine emits its own `land`
 * row, the mock harness doesn't. Exported for unit tests.
 */
export function withLandRowFirst(
  rows: readonly CostRow[],
  landRange: CostRange,
  landLabel: string,
): CostRow[] {
  return rows.some((row) => row.key === 'land')
    ? [...rows]
    : [{ key: 'land', label: landLabel, range: landRange }, ...rows];
}

/**
 * M1 estimate report page (the payoff screen).
 *
 * Pre-gate it renders the blurred preview with the single "Unlock" CTA toward
 * the lead gate; post-gate it renders the verified snapshot: hero ranges,
 * itemized breakdown, tier what-if, inline sqft adjust + re-run, AI narrative
 * placeholder, next steps, partner share, PDF, and callback.
 *
 * Money rule: the component never computes dollar figures — it displays what
 * the API returned, including the deterministic base from each range.
 */
@Component({
  selector: 'app-report-page',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './report-page.component.html',
  styleUrls: ['../wizard/wizard-shell.scss', './report-page.component.scss'],
})
export class ReportPageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly api = inject(API_SERVICE);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);

  /** Report copy (config-owned). */
  protected readonly copy = this.config.get('copy').report;
  /** Tier names/blumbs live with the wizard copy — reused, never duplicated. */
  protected readonly tierOptions = this.config.get('copy').wizard.scopeTiers;
  /** Wizard tunables bound the sqft stepper (config-owned). */
  protected readonly wizard = this.config.get('wizard');
  protected readonly narrativeDisclaimer = this.config.get('copy').narrativeDisclaimer;

  protected readonly property = this.store.selectSignal(WizardState.property);
  protected readonly wizardInputs = this.store.selectSignal(WizardState.inputs);
  protected readonly preview = this.store.selectSignal(ReportState.preview);
  protected readonly snapshot = this.store.selectSignal(ReportState.snapshot);
  protected readonly reportToken = this.store.selectSignal(ReportState.reportToken);
  protected readonly status = this.store.selectSignal(ReportState.status);
  protected readonly loadError = this.store.selectSignal(ReportState.error);
  protected readonly leadEmail = this.store.selectSignal(LeadState.email);

  /** Post-gate once a verified snapshot exists. */
  protected readonly unlocked = computed(() => this.snapshot() !== null);
  protected readonly loading = computed(() => this.status() === 'loading');

  /**
   * A lead was submitted this session but the report is still locked: the
   * magic-link email is on its way (real backend) — sending the user back to
   * the gate here would loop them to an empty form, so the locked view shows
   * the "check your email" state instead of the unlock CTA.
   */
  protected readonly pendingLead = computed(
    () => !this.unlocked() && this.leadEmail() !== null,
  );

  /** Currently selected tier (snapshot post-gate, wizard inputs pre-gate). */
  protected readonly activeTier = computed<FinishTier>(
    () => this.snapshot()?.inputs.tier ?? this.wizardInputs().tier,
  );

  /** Hero figures post-gate; null pre-gate (blurred cards render instead). */
  protected readonly figures = computed(() => {
    const snap = this.snapshot();
    return snap ? { build: snap.buildRange, total: snap.totalRange, land: snap.landRange } : null;
  });

  /**
   * Breakdown rows: land first, then whatever the API returned. The land row
   * is synthesized only when the API didn't send one (the real cost engine
   * emits its own `land` row; the mock harness doesn't).
   */
  protected readonly rows = computed<CostRow[]>(() => {
    const snap = this.snapshot();
    return snap ? withLandRowFirst(snap.rows, snap.landRange, this.copy.landRowLabel) : [];
  });

  protected readonly version = computed(() => this.snapshot()?.version ?? null);

  /** Sqft stepper draft, seeded from the latest snapshot (or wizard inputs). */
  protected readonly sqftDraft = signal(0);
  private lastSnapshotVersion = -1;

  protected readonly shareForm = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
  });
  protected readonly shareStatus = signal<FormStatus>('idle');

  protected readonly callbackForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    window: new FormControl<CallbackWindow>('morning', { nonNullable: true }),
  });
  protected readonly callbackStatus = signal<FormStatus>('idle');

  constructor() {
    // Keep the stepper draft in sync with re-runs without clobbering the
    // user's in-progress edits between snapshots.
    effect(() => {
      const snap = this.snapshot();
      if (snap && snap.version !== this.lastSnapshotVersion) {
        this.lastSnapshotVersion = snap.version;
        this.sqftDraft.set(snap.inputs.sqft);
      }
    });
  }

  ngOnInit(): void {
    this.seo.setForRoute('estimate/report');
    this.sqftDraft.set(this.wizardInputs().sqft);
    if (this.reportToken()) {
      this.store.dispatch(new UnlockReport());
    } else {
      this.store.dispatch(new LoadPreview());
    }
  }

  protected formatCad(value: number): string {
    return `$${value.toLocaleString('en-CA')}`;
  }

  protected formatSqft(value: number): string {
    return value.toLocaleString('en-CA') + ' ' + this.copy.adjustUnit;
  }

  protected get shareEmailInvalid(): boolean {
    const control = this.shareForm.controls.email;
    return control.touched && control.invalid;
  }

  /** Full-page error card: nothing loaded yet. */
  protected get showFullError(): boolean {
    return this.status() === 'error' && !this.snapshot() && !this.preview();
  }

  /** Inline banner: a re-run failed but the last good report stays visible. */
  protected get showInlineError(): boolean {
    return this.status() === 'error' && (this.snapshot() !== null || this.preview() !== null);
  }

  protected get callbackDetailsInvalid(): boolean {
    const controls = this.callbackForm.controls;
    return this.callbackForm.touched && (controls.name.invalid || controls.phone.invalid);
  }

  /** Tier what-if: re-runs the estimate through the API post-gate. */
  chooseTier(tier: FinishTier): void {
    if (!this.unlocked() || this.loading() || tier === this.activeTier()) {
      return;
    }
    this.store.dispatch([new ReviseReport(tier), new UpdateInputs({ tier })]);
  }

  adjustSqft(delta: number): void {
    const { sqftMin, sqftMax } = this.wizard;
    const next = Math.min(sqftMax, Math.max(sqftMin, this.sqftDraft() + delta));
    this.sqftDraft.set(next);
  }

  /** Inline adjust: re-runs the estimate with the stepper value. */
  rerun(): void {
    if (!this.unlocked() || this.loading()) {
      return;
    }
    const sqft = this.sqftDraft();
    this.store.dispatch([new ReviseReport(undefined, sqft), new UpdateInputs({ sqft })]);
  }

  retry(): void {
    if (this.reportToken()) {
      this.store.dispatch(new UnlockReport());
    } else {
      this.store.dispatch(new LoadPreview());
    }
  }

  shareWithPartner(): void {
    const token = this.reportToken();
    if (this.shareStatus() === 'sending' || this.shareForm.invalid) {
      this.shareForm.markAllAsTouched();
      return;
    }
    if (!token) {
      // The token is memory-only: after a reload it is gone, and the
      // magic-link email is the only re-verification path. Fail honestly
      // instead of flagging the user's valid email as invalid.
      this.shareStatus.set('error');
      return;
    }
    this.shareStatus.set('sending');
    this.api
      .shareWithPartner({ reportToken: token, partnerEmail: this.shareForm.controls.email.value })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.shareStatus.set('sent'),
        error: () => this.shareStatus.set('error'),
      });
  }

  requestCallback(): void {
    const token = this.reportToken();
    if (this.callbackStatus() === 'sending' || this.callbackForm.invalid) {
      this.callbackForm.markAllAsTouched();
      return;
    }
    if (!token) {
      // Same memory-only token note as shareWithPartner: fail honestly.
      this.callbackStatus.set('error');
      return;
    }
    this.callbackStatus.set('sending');
    const { name, phone, window } = this.callbackForm.getRawValue();
    this.api
      .requestCallback({ reportToken: token, name, phone, window })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.callbackStatus.set('sent'),
        error: () => this.callbackStatus.set('error'),
      });
  }

  /** v1 PDF: the print stylesheet lays the report out for Save-as-PDF. */
  print(): void {
    window.print();
  }
}
