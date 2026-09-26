import { Component, DestroyRef, OnInit, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import type { CallbackWindow, CostRange, FinishTier } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { mockNarrative } from '../../core/api/mock-data';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent, TierSelectorComponent } from '../../shared/components';
import { aggregateCostBuckets, type CostBucket } from '../../shared/cost-buckets';
import { UpdateInputs, WizardState, LeadState } from '../wizard';
import { AnalyticsService } from '../consent';
import { LoadPreview, ReviseReport, UnlockReport } from './report.actions';
import { ReportState } from './report.state';

/**
 * Fills a `{token}` config template (FE0-002: user-facing copy lives in
 * ConfigService, never in components). Module-local: only the report's
 * mailto: share uses it.
 */
function fillTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

/** One-shot form lifecycle for the callback form. */
type FormStatus = 'idle' | 'sending' | 'sent' | 'error';

export interface ShareMailtoArgs {
  to: string;
  subject: string;
  body: string;
}

/**
 * Builds the `mailto:` draft for the email share (AC12): the recipient's own
 * mail client sends the email, so there is no send state to track. Pure —
 * exported for unit tests. The body copy comes from the
 * `report.shareBodyTemplate` config template, filled by the caller.
 */
export function buildEstimateShareMailto(args: ShareMailtoArgs): string {
  return (
    `mailto:${encodeURIComponent(args.to)}` +
    `?subject=${encodeURIComponent(args.subject)}` +
    `&body=${encodeURIComponent(args.body)}`
  );
}

/**
 * Estimate report page (the payoff screen).
 *
 * Pre-gate it renders the real computed figures blurred (CSS `filter: blur()`,
 * `aria-hidden`, unselectable — the blur is a lead-capture nudge, not a
 * security boundary) with the single "Unlock" CTA toward the lead gate;
 * post-gate it renders the verified snapshot: ONE prominent
 * total with its likely planning range, the highlighted build cost, the fixed
 * City-assessed land figure, the always-on sqft stepper (debounced live
 * revise), the tier what-if toggle (debounced live revise), the 3-bucket
 * breakdown, the AI narrative, next steps, email share, and callback.
 *
 * Money rule: the component never computes dollar figures — it displays what
 * the API returned, including the deterministic base from each range. The one
 * exception is the per-sq-ft context line, which divides the server's build
 * base by the server's sqft for display only.
 */
@Component({
  selector: 'app-report-page',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, SiteFooterComponent, SiteNavComponent, TierSelectorComponent],
  templateUrl: './report-page.component.html',
  styleUrls: ['../wizard/wizard-shell.scss', './report-page.component.scss'],
})
export class ReportPageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly api = inject(API_SERVICE);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly analytics = inject(AnalyticsService);

  /** Report copy (config-owned). */
  protected readonly copy = this.config.get('copy').report;
  /** Tier names live with the wizard copy — reused, never duplicated. */
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

  /** Wizard project type (reactive): the pre-gate source of truth for reno. */
  private readonly wizardProjectType = this.store.selectSignal(WizardState.projectType);

  /**
   * True when this is a renovation report (vs new-build): the verified
   * snapshot says so post-gate, or the wizard is in the renovation flow
   * pre-gate (the blurred preview contract carries no renoInputs).
   */
  protected readonly isReno = computed(
    () => this.snapshot()?.projectType === 'renovation' || this.wizardProjectType() === 'renovation',
  );

  /** Wizard reno inputs (reactive): pre-gate source for reno type/area. */
  private readonly wizardRenoInputs = this.store.selectSignal(WizardState.renoInputs);

  /** Reno inputs: verified snapshot post-gate, wizard state pre-gate. */
  protected readonly renoInputs = computed(
    () => this.snapshot()?.renoInputs ?? this.wizardRenoInputs(),
  );

  /** Display name of the renovation type (e.g. "Extensive remodel"). */
  protected readonly renoTypeLabel = computed(() => {
    const reno = this.renoInputs();
    if (!reno?.renoType) {
      return null;
    }
    const found = this.config.get('copy').wizard.renoTypes.find((t) => t.id === reno.renoType);
    return found?.name ?? reno.renoType;
  });

  /** Affected-area cap for the current reno type (additions bill at most 400 sq ft). */
  protected readonly renoSqftCap = computed(() => {
    const reno = this.renoInputs();
    return reno?.renoType === 'addition' ? this.wizard.renoAdditionCap : this.wizard.renoSqftMax;
  });

  /** Affected area to display on reno reports (snapshot post-gate, wizard inputs pre-gate). */
  protected readonly renoSqftDisplay = computed(() => this.renoInputs()?.renoSqft ?? 0);

  /** Stepper copy switches to affected-area wording on reno reports. */
  protected readonly stepperTitle = computed(() =>
    this.isReno() ? this.copy.adjustTitleReno : this.copy.adjustTitle,
  );
  protected readonly stepperHint = computed(() =>
    this.isReno() ? this.copy.adjustHintReno : this.copy.adjustHint,
  );
  protected readonly stepperLockedNote = computed(() =>
    this.isReno() ? this.copy.adjustLockedNoteReno : this.copy.adjustLockedNote,
  );

  /** Engine-authored assumptions (reno only). */
  protected readonly assumptions = computed(() => this.snapshot()?.assumptions ?? []);

  /**
   * A lead was submitted this session but the report is still locked: the
   * magic-link email is on its way (real backend) — sending the user back to
   * the gate here would loop them to an empty form, so the locked view shows
   * the "check your email" state instead of the unlock CTA.
   */
  protected readonly pendingLead = computed(
    () => !this.unlocked() && this.leadEmail() !== null,
  );

  /**
   * "Updated {date}" — shown when an old magic link resolved to a newer
   * snapshot (consumer/02). The backend sets `snapshot.updatedAt` when the
   * link's original estimate was superseded. Null for first-view reports.
   */
  protected readonly updatedLabel = computed(() => {
    const updatedAt = this.snapshot()?.updatedAt;
    if (!updatedAt) return null;
    const date = new Date(updatedAt).toLocaleDateString('en-CA', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    return this.copy.updatedLabel.replace('{date}', date);
  });

  /** Chosen finish tier, display-only (snapshot post-gate, wizard inputs pre-gate). */
  protected readonly tierLabel = computed(() => {
    const tier = this.snapshot()?.inputs.tier ?? this.wizardInputs().tier;
    return this.tierOptions.find((t) => t.id === tier)?.name ?? tier;
  });

  /**
   * Hero figures post-gate; null pre-gate (blurred cards render instead).
   * Land is the FIXED City assessed value — never a range.
   */
  protected readonly figures = computed(() => {
    const snap = this.snapshot();
    return snap ? { build: snap.buildRange, total: snap.totalRange, landValue: snap.landValue } : null;
  });

  /** The 3-bucket breakdown (shared helper, D-01). Land is not a bucket. */
  protected readonly buckets = computed<readonly CostBucket[]>(() => {
    const snap = this.snapshot();
    return snap ? aggregateCostBuckets(snap.rows) : [];
  });

  /**
   * AI summary: the server-authored narrative (deterministic — engine figures
   * only, no LLM-invented numbers). Falls back to the mock narrative shape
   * when the backend ships an empty one. Re-renders on every revision, so a
   * size change refreshes it along with the figures.
   */
  protected readonly narrative = computed(() => {
    const snap = this.snapshot();
    if (!snap) {
      return '';
    }
    if (snap.narrative.trim()) {
      return snap.narrative;
    }
    const deterministic = mockNarrative(
      snap.inputs,
      { build: snap.buildRange, total: snap.totalRange, land: snap.landValue },
      this.tierLabel(),
    );
    return `${deterministic} ${this.narrativeDisclaimer}`;
  });

  /** Per-sq-ft context from the SERVER's build base and sqft — display only. */
  protected readonly perSqft = computed(() => {
    const snap = this.snapshot();
    const f = this.figures();
    if (!snap || !f || snap.inputs.sqft <= 0) {
      return null;
    }
    return Math.round(f.build.base / snap.inputs.sqft);
  });

  protected readonly snapshotSqft = computed(() => this.snapshot()?.inputs.sqft ?? 0);
  protected readonly version = computed(() => this.snapshot()?.version ?? null);

  /** Sqft stepper draft, seeded from the latest snapshot (or wizard inputs). */
  protected readonly sqftDraft = signal(0);
  private lastSnapshotVersion = -1;
  /** A size the user tapped but whose debounced revise hasn't fired yet. */
  private pendingReviseSqft: number | null = null;
  /** Raw stepper taps; the ngOnInit pipeline debounces them into revises. */
  private readonly sqftRevisions = new Subject<number>();

  /** Tier what-if draft (FE5-002), seeded from the latest snapshot (or wizard inputs). */
  protected readonly tierDraft = signal<FinishTier | null>(null);
  /** A tier the user picked but whose debounced revise hasn't fired yet. */
  private pendingReviseTier: FinishTier | null = null;
  /** Raw tier picks; the ngOnInit pipeline debounces them into revises. */
  private readonly tierRevisions = new Subject<FinishTier>();

  protected readonly shareForm = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
  });

  protected readonly callbackForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    window: new FormControl<CallbackWindow>('morning', { nonNullable: true }),
  });
  protected readonly callbackStatus = signal<FormStatus>('idle');

  constructor() {
    // Keep the stepper and tier drafts in sync with re-runs without
    // clobbering a value the user just picked but whose debounced revise is
    // still pending.
    effect(() => {
      const snap = this.snapshot();
      if (snap && snap.version !== this.lastSnapshotVersion) {
        this.lastSnapshotVersion = snap.version;
        if (this.pendingReviseSqft === null) {
          this.sqftDraft.set(snap.inputs.sqft);
        }
        if (this.pendingReviseTier === null) {
          this.tierDraft.set(snap.inputs.tier);
        }
      }
    });
  }

  ngOnInit(): void {
    this.seo.setForRoute('estimate/report');
    // Reno reports step the affected area, not the new-build living area:
    // seed the drafts from the reno inputs when in the renovation flow.
    if (this.isReno()) {
      this.sqftDraft.set(this.wizardRenoInputs().renoSqft);
      this.tierDraft.set(this.wizardRenoInputs().tier);
    } else {
      this.sqftDraft.set(this.wizardInputs().sqft);
      this.tierDraft.set(this.wizardInputs().tier);
    }
    // D-02: rapid stepper taps coalesce into one revise. distinctUntilChanged
    // drops no-op re-emissions; the state's cancelUncompleted gives switchMap
    // semantics so a stale in-flight response can never overwrite a newer one.
    this.sqftRevisions
      .pipe(
        // D-02: trailing debounce on the sqft stepper. 400 ms lets rapid taps
        // coalesce into one backend revision while still feeling instant; the
        // value is a config timing so it can be tuned per deploy, and the
        // ≤ 500 ms cap is pinned in the component spec.
        debounceTime(this.config.get('timings').reviseDebounceMs),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((sqft) => this.dispatchSqftRevision(sqft));
    // FE5-002: the same debounce pipeline drives tier what-if picks — rapid
    // toggling coalesces into one revision and last-write-wins.
    this.tierRevisions
      .pipe(
        debounceTime(this.config.get('timings').reviseDebounceMs),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((tier) => this.dispatchTierRevision(tier));
    if (this.reportToken()) {
      this.store.dispatch(new UnlockReport());
    } else {
      this.store.dispatch(new LoadPreview());
    }
  }

  protected formatCad(value: number): string {
    return `$${Math.round(value).toLocaleString('en-CA')}`;
  }

  /** Blurred pre-gate range, e.g. "$608,000 – $735,000". */
  protected previewRange(range: CostRange): string {
    return this.formatCad(range.low) + ' – ' + this.formatCad(range.high);
  }

  protected formatSqft(value: number): string {
    return value.toLocaleString('en-CA') + ' ' + this.copy.adjustUnit;
  }

  protected bucketsAriaLabel(): string {
    return this.buckets()
      .map((b) => `${b.label}: ${this.formatCad(b.range.base)}`)
      .join(', ');
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

  /** Always-on stepper: every tap updates the draft immediately and queues a debounced revise. */
  adjustSqft(delta: number): void {
    if (!this.unlocked()) {
      return;
    }
    // Reno reports step the affected area within the reno bounds (addition
    // cap applies); new-build reports step the living area.
    const min = this.isReno() ? this.wizard.renoSqftMin : this.wizard.sqftMin;
    const max = this.isReno() ? this.renoSqftCap() : this.wizard.sqftMax;
    const next = Math.min(max, Math.max(min, this.sqftDraft() + delta));
    if (next === this.sqftDraft()) {
      return;
    }
    this.sqftDraft.set(next);
    this.pendingReviseSqft = next;
    this.sqftRevisions.next(next);
  }

  private dispatchSqftRevision(sqft: number): void {
    this.pendingReviseSqft = null;
    if (!this.unlocked()) {
      return;
    }
    this.store.dispatch([new ReviseReport(undefined, sqft), new UpdateInputs({ sqft })]);
  }

  /** Tier what-if pick (FE5-002): updates the draft immediately, queues a debounced revise. */
  selectTier(tier: FinishTier): void {
    if (!this.unlocked() || tier === this.tierDraft()) {
      return;
    }
    this.tierDraft.set(tier);
    this.pendingReviseTier = tier;
    this.tierRevisions.next(tier);
  }

  private dispatchTierRevision(tier: FinishTier): void {
    this.pendingReviseTier = null;
    if (!this.unlocked()) {
      return;
    }
    this.store.dispatch([new ReviseReport(tier), new UpdateInputs({ tier })]);
  }

  retry(): void {
    if (this.reportToken()) {
      this.store.dispatch(new UnlockReport());
    } else {
      this.store.dispatch(new LoadPreview());
    }
  }

  /**
   * Email share (AC12): opens a `mailto:` draft prefilled with the current
   * size and exact numbers. The recipient's own mail client sends the email —
   * the honest v1 until the saved-link share ships with story email/01.
   */
  shareViaEmail(): void {
    const snap = this.snapshot();
    const f = this.figures();
    if (this.shareForm.invalid) {
      this.shareForm.markAllAsTouched();
      return;
    }
    if (!snap || !f) {
      return;
    }
    const to = this.shareForm.controls.email.value.trim();
    const address = this.property()?.address ?? 'your Calgary property';
    const subject = [this.copy.shareSubject, address].filter(Boolean).join(' — ');
    const fmt = (n: number): string => '$' + Math.round(n).toLocaleString('en-CA');
    const body = fillTemplate(this.copy.shareBodyTemplate, {
      address,
      sqft: snap.inputs.sqft.toLocaleString('en-CA'),
      tierLabel: this.tierLabel(),
      total: fmt(f.total.base),
      rangeLow: fmt(f.total.low),
      rangeHigh: fmt(f.total.high),
      build: fmt(f.build.base),
      land: fmt(f.landValue.value),
      planningRangeLabel: this.copy.planningRangeLabel,
      buildLabel: this.copy.buildLabel,
      landLabel: this.copy.landLabel,
      landFixedNote: this.copy.landFixedNote,
      bodyClose: this.copy.shareBodyClose,
    });
    window.location.href = buildEstimateShareMailto({ to, subject, body });
    // Consent-gated inside AnalyticsService: declined/pending banner means
    // this is a silent no-op.
    this.analytics.track('partner_share');
  }

  requestCallback(): void {
    const token = this.reportToken();
    if (this.callbackStatus() === 'sending' || this.callbackForm.invalid) {
      this.callbackForm.markAllAsTouched();
      return;
    }
    if (!token) {
      // The token is memory-only: after a reload it is gone, and the
      // magic-link email is the only re-verification path. Fail honestly
      // instead of flagging the user's valid details as invalid.
      this.callbackStatus.set('error');
      return;
    }
    this.callbackStatus.set('sending');
    const { name, phone, window } = this.callbackForm.getRawValue();
    this.api
      .requestCallback({ reportToken: token, name, phone, window })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.callbackStatus.set('sent');
          // Consent-gated inside AnalyticsService.
          this.analytics.track('callback_request');
        },
        error: () => this.callbackStatus.set('error'),
      });
  }

  /** v1 PDF: the print stylesheet lays the report out for Save-as-PDF. */
  print(): void {
    // Consent-gated inside AnalyticsService: declined/pending banner means
    // this is a silent no-op.
    this.analytics.track('pdf_download');
    window.print();
  }
}
