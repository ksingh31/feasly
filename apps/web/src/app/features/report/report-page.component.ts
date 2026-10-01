import { Component, DestroyRef, OnInit, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import type { CallbackWindow, CostRange } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent, BuilderMatchingExplainerComponent } from '../../shared/components';
import { aggregateCostBuckets, type CostBucket } from '../../shared/cost-buckets';
import { isUnitLikeAddress } from '../../shared/utils/address';
import { formatWholeCad } from '../../shared/utils/money';
import { narrativeDisplayParagraphs } from '../../shared/utils/narrative-display';
import { UpdateInputs, WizardState, LeadState, ClearLead, ResetWizard } from '../wizard';
import { AnalyticsService } from '../consent';
import { ClearReport, LoadLeadEstimate, LoadPreview, ReviseReport, ToggleStep, UnlockReport } from './report.actions';
import { ReportState } from './report.state';
import { ReportPdfService } from './report-pdf.service';

/**
 * Fills a `{token}` config template (FE0-002: user-facing copy lives in
 * ConfigService, never in components). Module-local: only the report's
 * partner-share success message uses it.
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

/** Partner-share flow lifecycle: the backend mints the partner's own link. */
type ShareStatus = 'idle' | 'sending' | 'sent' | 'send-error' | 'token-error';

/**
 * Estimate report page (the payoff screen).
 *
 * Pre-gate it renders the real computed figures blurred (CSS `filter: blur()`,
 * `aria-hidden`, unselectable — the blur is a lead-capture nudge, not a
 * security boundary) with the single "Unlock" CTA toward the lead gate.
 * Post-gate — Karan directive 2026-09-27 — the submitted lead unlocks the
 * report IMMEDIATELY: no magic-link round-trip, no "check your email"
 * dead-end. The figures and cost rows come from the public estimate
 * endpoint (no new data exposure); the token-gated extras (AI narrative,
 * token revise, share, callback) still need the magic-link email, whose
 * role is now return-access on other devices. The page renders the full
 * unlocked report: ONE prominent total with its likely planning range, the
 * highlighted build cost, the fixed City-assessed land figure, the always-on
 * sqft stepper (debounced live revise), the 3-bucket breakdown, the AI
 * narrative (honest empty state until the magic link is clicked), next
 * steps, email share, callback, and the print/PDF button.
 *
 * Money rule: the component never computes dollar figures — it displays what
 * the API returned, including the deterministic base from each range. The one
 * exception is the per-sq-ft context line, which divides the server's build
 * base by the server's sqft for display only.
 */
@Component({
  selector: 'app-report-page',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, BuilderMatchingExplainerComponent, SiteFooterComponent, SiteNavComponent],
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
  private readonly router = inject(Router);
  private readonly pdfService = inject(ReportPdfService);

  /** Report copy (config-owned). */
  protected readonly copy = this.config.get('copy').report;
  /** Tier names live with the wizard copy — reused, never duplicated. */
  protected readonly tierOptions = this.config.get('copy').wizard.scopeTiers;
  /** Wizard tunables bound the sqft stepper (config-owned). */
  protected readonly wizard = this.config.get('wizard');

  protected readonly property = this.store.selectSignal(WizardState.property);
  protected readonly wizardInputs = this.store.selectSignal(WizardState.inputs);
  protected readonly preview = this.store.selectSignal(ReportState.preview);
  protected readonly snapshot = this.store.selectSignal(ReportState.snapshot);
  protected readonly reportToken = this.store.selectSignal(ReportState.reportToken);
  /**
   * True when the session redeemed a partner-share link: the page renders
   * the read-only partner view — no sqft stepper, no share form, no
   * callback form.
   */
  protected readonly partnerView = this.store.selectSignal(ReportState.partnerView);
  protected readonly status = this.store.selectSignal(ReportState.status);
  protected readonly loadError = this.store.selectSignal(ReportState.error);
  protected readonly leadEmail = this.store.selectSignal(LeadState.email);
  /** True when the last gate POST triggered a fresh magic-link email. */
  protected readonly magicLinkSent = this.store.selectSignal(LeadState.magicLinkSent);
  /** Idempotent resubmit (P0 2026-09-27): no new email — one already went out recently. */
  protected readonly emailAlreadySent = this.store.selectSignal(LeadState.emailAlreadySent);
  /** Why the magic-link email failed — undefined when it was sent. */
  protected readonly emailError = this.store.selectSignal(LeadState.emailError);
  /**
   * True once the lead gate was submitted (name + email). Karan directive
   * 2026-09-27: this alone unlocks the report — the magic-link email is
   * return-access for other devices, not the unlock key for this session.
   */
  private readonly leadId = this.store.selectSignal(LeadState.leadId);
  protected readonly leadSubmitted = computed(() => this.leadId() !== null);

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
   * Subtle post-gate note: the magic-link email is return-access for other
   * devices now, not the unlock key — the report above is already unlocked.
   * Four variants:
   * - sent (magicLinkSent): "we emailed you a link…"
   * - idempotent resubmit (emailAlreadySent): "your link is already in your
   *   inbox" — no new email went out because one already did recently
   *   (P0 2026-09-27: double-taps and retries never duplicate the email).
   * - send failed but unlocked, transient (magicLinkSent === false with a
   *   report token, emailError 'delivery-failed' or absent): "couldn't send
   *   the email link — check your inbox or try again later". An earlier
   *   retry attempt may still have sent it. Never a dead end (Karan
   *   directive 2026-09-27).
   * - send failed, bad address (emailError === 'invalid-recipient'): "check
   *   it for typos" — no "check your inbox", it will never arrive.
   * - quarantine (magicLinkSent === false, no token): the
   *   "already in your inbox" line.
   * Never shown in partner view (partners didn't submit the lead).
   */
  protected readonly showLeadLinkNote = computed(
    () => this.leadSubmitted() && !this.partnerView(),
  );
  protected readonly leadLinkNote = computed(() => {
    if (this.emailAlreadySent()) return this.copy.leadLinkNoteDuplicate;
    if (this.magicLinkSent()) return this.copy.leadLinkNote;
    if (!this.reportToken()) return this.copy.leadLinkNoteDuplicate;
    return this.emailError() === 'invalid-recipient'
      ? this.copy.leadLinkNoteInvalidRecipient
      : this.copy.leadLinkNoteFailed;
  });

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

  /** Honest one-line descriptor of the selected finish tier (no prices). */
  protected readonly tierDescriptor = computed(() => {
    const tier = this.snapshot()?.inputs.tier ?? this.wizardInputs().tier;
    const d = this.copy.tierDescriptors;
    return tier === 'luxury' ? d.luxury : tier === 'premium' ? d.premium : d.standard;
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
   * only, no LLM-invented numbers, verbatim footer included). The state
   * top-ups an empty snapshot narrative via POST /v1/estimates/{id}/narrative
   * before the snapshot lands here. Empty when unavailable — the template
   * shows the honest empty state, never mock text. When every model failed
   * (BE-9), the narrative is the static Calgary guide instead.
   */
  protected readonly narrative = computed(() => {
    const snap = this.snapshot();
    if (!snap) {
      return '';
    }
    return snap.narrative?.trim() ? snap.narrative : '';
  });

  /**
   * Static-guide mode (BE-9): the backend could not reach any narrative
   * model and returned the hard-coded Calgary guide, labeled
   * `narrativeSource: 'static-guide'`. Rendered under its own honest
   * title — never presented as AI prose.
   */
  protected readonly isStaticGuide = computed(
    () => this.snapshot()?.narrativeSource === 'static-guide',
  );

  /**
   * Static-guide paragraphs for rendering: the guide is stored as
   * \n\n-joined prose; the template renders one paragraph per block so
   * it reads as a guide, not a wall of text.
   */
  protected readonly guideParagraphs = computed(() => {
    if (!this.isStaticGuide()) {
      return [];
    }
    return this.narrative()
      .split('\n\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  });

  /**
   * Per-sq-ft context from the SERVER's build base and sqft — display only.
   * New-build only: the reno engine deliberately avoids per-sqft framing
   * (reno/04), so reno reports never surface this figure. The exact
   * quotient (not a rounded dollar) so the shown rate × the shown sqft
   * reconciles with the shown build cost as closely as display rounding
   * allows — "$242 × 2,400" used to imply $580,800 against a $580,830
   * build cost; the cents-precision display below closes that gap.
   */
  protected readonly perSqft = computed(() => {
    if (this.isReno()) {
      return null;
    }
    const snap = this.snapshot();
    const f = this.figures();
    if (!snap || !f || snap.inputs.sqft <= 0) {
      return null;
    }
    return f.build.base / snap.inputs.sqft;
  });

  /**
   * Formats a per-sq-ft rate: whole dollars when exact ("$242"), otherwise
   * cents precision ("$242.01"). Integer-cent math only — no float
   * formatting drift.
   */
  protected formatPerSqft(value: number): string {
    if (!Number.isFinite(value) || value < 0) {
      return this.formatCad(0);
    }
    const cents = Math.round(value * 100);
    if (cents % 100 === 0) {
      return this.formatCad(cents / 100);
    }
    const dollars = Math.trunc(cents / 100).toLocaleString('en-CA');
    return `$${dollars}.${String(cents % 100).padStart(2, '0')}`;
  }

  protected readonly snapshotSqft = computed(() => this.snapshot()?.inputs.sqft ?? 0);
  protected readonly version = computed(() => this.snapshot()?.version ?? null);

  /**
   * Next-steps checklist state (NGXS, persisted per report by leadId).
   * The steps themselves are config copy; only the checked ids live here.
   */
  protected readonly stepsChecked = this.store.selectSignal(ReportState.stepsChecked);
  protected isStepChecked(stepId: string): boolean {
    return this.stepsChecked()[stepId] === true;
  }
  protected toggleStep(stepId: string): void {
    this.store.dispatch(new ToggleStep(stepId));
  }
  protected readonly stepsDoneCount = computed(
    () => this.copy.steps.filter((s) => this.isStepChecked(s.id)).length,
  );
  protected readonly stepsProgressLabel = computed(() =>
    fillTemplate(this.copy.stepsProgress, {
      done: String(this.stepsDoneCount()),
      total: String(this.copy.steps.length),
    }),
  );

  /**
   * Unit-address honesty: a condo/apartment unit's City record carries the
   * WHOLE building's lot size and assessed land value. The land card says
   * so instead of implying the lot belongs to the unit.
   */
  protected readonly isUnitAddress = computed(() => {
    const address = this.property()?.address;
    return address ? isUnitLikeAddress(address) : false;
  });

  /** Sqft stepper draft, seeded from the latest snapshot (or wizard inputs). */
  protected readonly sqftDraft = signal(0);
  private lastSnapshotVersion = -1;
  /** A size the user tapped but whose debounced revise hasn't fired yet. */
  private pendingReviseSqft: number | null = null;
  /** Raw stepper taps; the ngOnInit pipeline debounces them into revises. */
  private readonly sqftRevisions = new Subject<number>();

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
    // Keep the stepper draft in sync with re-runs without clobbering a
    // value the user just picked but whose debounced revise is still
    // pending.
    effect(() => {
      const snap = this.snapshot();
      if (snap && snap.version !== this.lastSnapshotVersion) {
        this.lastSnapshotVersion = snap.version;
        if (this.pendingReviseSqft === null) {
          this.sqftDraft.set(snap.inputs.sqft);
        }
      }
    });
    // A downloaded PDF's object URL outlives the click that created it —
    // revoke it when the page goes away so blob memory is never leaked.
    this.destroyRef.onDestroy(() => {
      if (this.lastPdfUrl) {
        URL.revokeObjectURL(this.lastPdfUrl);
        this.lastPdfUrl = null;
      }
    });
  }

  ngOnInit(): void {
    this.seo.setForRoute('estimate/report');
    // Reno reports step the affected area, not the new-build living area:
    // seed the draft from the reno inputs when in the renovation flow.
    if (this.isReno()) {
      this.sqftDraft.set(this.wizardRenoInputs().renoSqft);
    } else {
      this.sqftDraft.set(this.wizardInputs().sqft);
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
    if (this.reportToken()) {
      this.store.dispatch(new UnlockReport());
    } else if (this.leadSubmitted()) {
      // Karan directive 2026-09-27: the submitted lead unlocks the report
      // immediately — no magic-link round-trip, no blurred dead-end.
      this.store.dispatch(new LoadLeadEstimate());
    } else {
      this.store.dispatch(new LoadPreview());
    }
  }

  protected formatCad(value: number): string {
    return formatWholeCad(value);
  }

  /** Blurred pre-gate range, e.g. "$608,000 – $735,000". */
  protected previewRange(range: CostRange): string {
    return this.formatCad(range.low) + ' – ' + this.formatCad(range.high);
  }

  protected formatSqft(value: number): string {
    return value.toLocaleString('en-CA') + ' ' + this.copy.adjustUnit;
  }

  /**
   * AI-summary display paragraphs. New narratives are plain-text
   * neighbourhood guides (blank-line-separated) and pass through as-is;
   * older stored narratives with markdown, duplication, or a fused footer
   * degrade gracefully via the shared display helper.
   */
  protected readonly narrativeParagraphs = computed(() =>
    narrativeDisplayParagraphs(this.narrative()),
  );

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
    if (!this.unlocked() || this.partnerView()) {
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

  retry(): void {
    if (this.reportToken()) {
      this.store.dispatch(new UnlockReport());
    } else if (this.leadSubmitted()) {
      this.store.dispatch(new LoadLeadEstimate());
    } else {
      this.store.dispatch(new LoadPreview());
    }
  }

  /**
   * Partner share (share/01): the backend mints the partner their OWN fresh
   * magic link and sends the structured Feasly email — the recipient never
   * gets the owner's token. Same missing-token pattern as requestCallback:
   * the token is memory-only, so after a reload it is gone.
   */
  protected readonly shareStatus = signal<ShareStatus>('idle');
  /** Recipient of the last successful share, named in the success message. */
  protected readonly shareSentTo = signal('');
  protected readonly shareSentMessage = computed(() =>
    fillTemplate(this.copy.shareSent, { email: this.shareSentTo() }),
  );

  shareViaEmail(): void {
    const token = this.reportToken();
    if (this.shareStatus() === 'sending') {
      return;
    }
    if (this.shareForm.invalid) {
      this.shareForm.markAllAsTouched();
      return;
    }
    if (!token) {
      // The token is memory-only: after a reload it is gone, and the
      // magic-link email is the only re-verification path. Fail honestly
      // instead of flagging the user's valid details as invalid.
      this.shareStatus.set('token-error');
      return;
    }
    if (this.partnerView()) {
      // Belt-and-suspenders: the section is hidden in partner view, and the
      // backend rejects partner tokens with 403.
      return;
    }
    const partnerEmail = this.shareForm.controls.email.value.trim();
    this.shareStatus.set('sending');
    this.api
      .shareWithPartner({ reportToken: token, partnerEmail })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.shareStatus.set('sent');
          this.shareSentTo.set(partnerEmail);
          // Consent-gated inside AnalyticsService: declined/pending banner
          // means this is a silent no-op.
          this.analytics.track('partner_share');
        },
        error: () => this.shareStatus.set('send-error'),
      });
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
    if (this.partnerView()) {
      // Belt-and-suspenders: the section is hidden in partner view, and the
      // backend rejects partner tokens with 403.
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

  /** Download-PDF button state: idle → generating → idle, or error with retry. */
  protected readonly pdfState = signal<'idle' | 'generating' | 'error'>('idle');
  /** Last created object URL — revoked before the next download and on destroy. */
  private lastPdfUrl: string | null = null;

  /**
   * Real client-side PDF download (QA finding: the old window.print() call
   * appeared inert — no download, no feedback). Generates the PDF from the
   * verified snapshot, triggers a real file download, and surfaces
   * generating/error states on the button. jsPDF is lazy-loaded by the
   * service so the public bundle never pays for it until clicked.
   */
  async downloadPdf(): Promise<void> {
    const snapshot = this.snapshot();
    const property = this.property();
    if (!snapshot || !property || this.pdfState() === 'generating') {
      return;
    }
    // Consent-gated inside AnalyticsService: declined/pending banner means
    // this is a silent no-op.
    this.analytics.track('pdf_download');
    this.pdfState.set('generating');
    try {
      const preparedDate = new Date(snapshot.preparedAt).toLocaleDateString('en-CA', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const blob = await this.pdfService.generate({
        snapshot,
        address: property.address,
        title: this.isReno() ? 'Renovation estimate' : 'New-build cost report',
        preparedLine: `Prepared ${preparedDate}`,
        versionLine: `${this.copy.versionLabel} ${snapshot.version}`,
        steps: this.copy.steps,
        disclaimer: this.config.get('copy').narrativeDisclaimer,
        uncalibratedNote: this.copy.uncalibratedNote,
      });
      // Revoke the previous download URL before minting a new one.
      if (this.lastPdfUrl) {
        URL.revokeObjectURL(this.lastPdfUrl);
      }
      const url = URL.createObjectURL(blob);
      this.lastPdfUrl = url;
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `feasly-estimate-${snapshot.version}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      this.pdfState.set('idle');
    } catch {
      this.pdfState.set('error');
    }
  }

  /**
   * "Estimate another address": restart the funnel on the landing page with a
   * genuinely fresh estimate — clear the report, lead, and wizard state so no
   * stale figures, tokens, or property leak into the next run. Programmatic
   * navigation (not anchor interception) — the same `router.navigate` path
   * the landing page's own property-select uses, so the restart can never
   * depend on click-interception quirks. The href keeps it a real link
   * (keyboard, open-in-new-tab, crawlers).
   */
  startNewEstimate(event: Event): void {
    event.preventDefault();
    this.store.dispatch([new ClearReport(), new ClearLead(), new ResetWizard()]);
    void this.router.navigate(['/']);
  }
}
