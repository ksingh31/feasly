import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import type { AbstractControl } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { map, of, switchMap, tap } from 'rxjs';
import type { TimelineOption } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { buildNewBuildRequest } from '../../core/api/build-estimate-request';
import { cachedPreviewFor, previewRequestKey } from '../../core/api/preview-cache';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { BuilderMatchingExplainerComponent, SiteFooterComponent, SiteNavComponent, WizardBackComponent, WizardStepsComponent } from '../../shared/components';
import { EmbedState } from '../embed/embed.state';
import { StoreLeadResult, StorePreviewEstimate, WizardState } from '../wizard';
import type { WizardStep } from './wizard.actions';
import { SetReportToken } from '../report/report.actions';
import { ComparisonLeadSubmitted, ComparisonState } from '../compare';
import { AnalyticsService } from '../consent';
import { EmbedBridgeService } from '../embed/embed-bridge.service';

type GateStatus = 'idle' | 'sending' | 'error';

/**
 * Lead gate (FE-004): the single gate in the flow.
 *
 * Name + email + timeline required, phone optional. The contact-consent
 * checkbox is REQUIRED to submit (Karan 2026-09-27): Feasly and builders
 * associated with us may proactively contact the lead about their estimate;
 * the lead can opt out anytime. Consent wording is a DRAFT pending legal
 * review — see copy.gate.consentLabel.
 *
 * On submit the lead attaches to the estimate the user just saw on the
 * preview step (#489): the lead contract requires an `estimateId`, and the
 * real API mints a new UUID on every preview call, so the gate reuses the
 * cached preview (wizard slice) when the request is unchanged. Only when no
 * matching preview is cached (e.g. a fresh tab) does it mint one — and it
 * writes that preview back to the cache, so the analyzing screen and the
 * report reuse it too. Then it POSTs the lead and routes to the analyzing
 * screen. Loading and honest error states included; the error banner
 * retries the whole submit.
 */
@Component({
  selector: 'app-gate-page',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    BuilderMatchingExplainerComponent,
    SiteFooterComponent,
    SiteNavComponent,
    WizardBackComponent,
    WizardStepsComponent,
  ],
  templateUrl: './gate-page.component.html',
  styleUrls: ['./wizard-shell.scss', './gate-page.component.scss'],
})
export class GatePageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(API_SERVICE);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly analytics = inject(AnalyticsService);
  private readonly bridge = inject(EmbedBridgeService);

  /** Gate copy (config-owned). */
  protected readonly copy = this.config.get('copy').gate;
  private readonly phonePattern = new RegExp(this.copy.phonePattern);

  /** Reactive project type (RENO-06) — drives the timeline question variant. */
  private readonly projectType = this.store.selectSignal(WizardState.projectType);

  /**
   * RENO-06: the timeline question reads for the user's project type.
   * Copy stays in config — the component only selects the variant.
   */
  protected get timelineLabel(): string {
    return this.projectType() === 'renovation'
      ? this.copy.timelineLabelReno
      : this.copy.timelineLabel;
  }

  protected readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    phone: ['', (control: AbstractControl) => {
      const value = (control.value as string | null)?.trim() ?? '';
      return value === '' || this.phonePattern.test(value) ? null : { phoneInvalid: true };
    }],
    timeline: ['' as TimelineOption | '', Validators.required],
    // Contact consent (Karan 2026-09-27): REQUIRED to submit. Feasly and
    // builders associated with us may contact the lead about their estimate;
    // the lead can opt out anytime. Wording is a DRAFT pending legal review.
    consent: [false, Validators.requiredTrue],
    // HRD-03 honeypot: visually hidden; humans never fill it, bots do.
    // A filled value quarantines the lead server-side (still 201).
    website: [''],
  });

  protected status: GateStatus = 'idle';

  /** EMB-03: embed context from the session-scoped EmbedState. */
  protected readonly embedStatus = this.store.selectSignal(EmbedState.status);
  protected readonly embedConfig = this.store.selectSignal(EmbedState.config);
  protected readonly embedTenantKey = this.store.selectSignal(EmbedState.tenantKey);

  /** True when the gate is rendered inside a builder embed with a loaded config. */
  protected get isEmbed(): boolean {
    return this.embedTenantKey() !== null && this.embedStatus() === 'ready';
  }

  /** Builder display name from the signed embed config (never from URL params). */
  protected get builderName(): string {
    return this.embedConfig()?.display_name ?? '';
  }

  /** EMB-03 fail-closed: config failed to load → gate does not render. */
  protected get embedUnavailable(): boolean {
    return this.embedTenantKey() !== null && this.embedStatus() === 'error';
  }

  ngOnInit(): void {
    this.seo.setForRoute('estimate/gate');
  }

  /**
   * Comparison mode (NBH-03): the gate was entered from /estimate/compare
   * (`?flow=comparison`) with an active comparison result. The same single
   * gate UI and lead contract — but the estimateId already exists (minted by
   * the comparison pipeline), the wizard steps hide, and success returns to
   * the comparison instead of the analyzing screen.
   */
  protected get isComparisonFlow(): boolean {
    return this.route.snapshot.queryParamMap.get('flow') === 'comparison';
  }

  /** True when the control is invalid and the user has interacted or submitted. */
  showError(controlName: 'name' | 'email' | 'phone' | 'timeline' | 'consent'): boolean {
    const control = this.form.get(controlName);
    return !!control && control.invalid && (control.touched || control.dirty);
  }

  /**
   * Back-bar target (#485): comparison leads return to compare; wizard leads
   * return to the preview they just saw (the gate is entered from it).
   */
  protected backLink(): string {
    return this.isComparisonFlow ? '/estimate/compare' : '/estimate/preview';
  }

  /**
   * Wizard step dispatched on back: the preview sits at step 3 (scope moves
   * the wizard to 3 before it), so returning there keeps step 3; the
   * comparison flow keeps its prior behavior.
   */
  protected backStep(): WizardStep {
    return this.isComparisonFlow ? 2 : 3;
  }

  /** Back-bar label matching {@link backLink}. */
  protected backLabel(): string {
    return this.isComparisonFlow ? this.copy.backLabelComparison : this.copy.backLabel;
  }

  onSubmit(): void {
    if (this.status === 'sending') {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    // Comparison mode (NBH-03): the estimateId was already minted by the
    // comparison pipeline — submit the lead against it and unlock.
    if (this.isComparisonFlow) {
      this.submitComparisonLead();
      return;
    }
    this.status = 'sending';
    const property = this.store.selectSnapshot(WizardState.property);
    const inputs = this.store.selectSnapshot(WizardState.inputs);
    if (!property) {
      // Unreachable behind wizardScopeGuard; fail honestly if it ever happens.
      this.status = 'error';
      return;
    }
    const values = this.form.getRawValue();
    // EMB-03: in embed context, the tenant key flows through to the backend
    // for server-side attribution. The backend validates the key against
    // the tenants table — it is never trusted blindly.
    const tenantKey = this.embedTenantKey() ?? undefined;
    // The lead must reference an estimate: reuse the preview the user saw
    // (#489) — mint one only when nothing matching is cached.
    const request = buildNewBuildRequest(property, inputs);
    const tenant = tenantKey ?? null;
    const cached = cachedPreviewFor(
      this.store.selectSnapshot(WizardState.previewCache),
      request,
      tenant,
    );
    const preview$ = cached
      ? of(cached)
      : this.api.getPreviewEstimate({ ...request, tenantKey }).pipe(
          tap((minted) =>
            this.store.dispatch(
              new StorePreviewEstimate(minted, previewRequestKey(request), tenant),
            ),
          ),
        );
    preview$
      .pipe(
        switchMap((preview) =>
          this.api
            .submitLead({
              estimateId: preview.estimateId,
              name: values.name.trim(),
              email: values.email.trim(),
              phone: values.phone.trim() === '' ? undefined : values.phone.trim(),
              timeline: values.timeline === '' ? 'exploring' : values.timeline,
              marketingConsent: values.consent,
              // HRD-03 honeypot — empty for humans, filled by bots.
              website: values.website,
              tenantKey,
            })
            .pipe(map((lead) => ({ lead, email: values.email.trim(), preview }))),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ({ lead, email, preview }) => {
          // The gate converted: consent-gated inside AnalyticsService, so a
          // declined/pending banner means this is a silent no-op.
          this.analytics.track('gate_convert');
          // Embed bridge (embed/08): tell the parent page a lead was created.
          // No-op when not embedded; carries zero PII (estimateId + score).
          this.bridge.notifyLeadCreated(lead.leadId, preview.estimateId, lead.leadScore);
          this.store.dispatch(
            new StoreLeadResult({
              leadId: lead.leadId,
              email,
              magicLinkSent: lead.magicLinkSent,
              expiresInDays: lead.expiresInDays,
              // Explicit (possibly undefined): clears a stale emailError
              // from an earlier failed submit on success.
              emailError: lead.emailError,
              // Idempotent resubmit (P0 2026-09-27): no new email was sent
              // because one already went out recently for this email +
              // property — the report page says "already in your inbox".
              emailAlreadySent: lead.emailAlreadySent,
            }),
          );
          // Karan directive 2026-09-27 (immediate unlock): the backend
          // returns the owner report token with the submit response, so the
          // same-session report can share, request callbacks, and revise
          // without waiting for the magic-link email (which is now
          // return-access for other devices).
          if (lead.reportToken) {
            this.store.dispatch(new SetReportToken(lead.reportToken));
          }
          void this.router.navigate(['/estimate/analyzing']);
        },
        error: () => {
          this.status = 'error';
        },
      });
  }

  /**
   * Comparison lead submit (NBH-03): the comparison estimateId already
   * exists, so the lead attaches directly to it. Success marks the
   * comparison unlocked and returns to /estimate/compare — no analyzing
   * screen, no re-mint. The unlock is the successful lead submission (the
   * comparison endpoint is public and returns full ranges; there is no
   * separate token verification step like the magic-link report).
   */
  private submitComparisonLead(): void {
    const result = this.store.selectSnapshot(ComparisonState.result);
    if (!result) {
      // Unreachable behind leadGateGuard; fail honestly if it ever happens.
      this.status = 'error';
      return;
    }
    this.status = 'sending';
    const values = this.form.getRawValue();
    this.api
      .submitLead({
        estimateId: result.estimateId,
        name: values.name.trim(),
        email: values.email.trim(),
        phone: values.phone.trim() === '' ? undefined : values.phone.trim(),
        timeline: values.timeline === '' ? 'exploring' : values.timeline,
        marketingConsent: values.consent,
        // HRD-03 honeypot — empty for humans, filled by bots.
        website: values.website,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (lead) => {
          this.analytics.track('gate_convert');
          this.store.dispatch(
            new StoreLeadResult({
              leadId: lead.leadId,
              email: values.email.trim(),
              magicLinkSent: lead.magicLinkSent,
              expiresInDays: lead.expiresInDays,
              emailError: lead.emailError,
              emailAlreadySent: lead.emailAlreadySent,
            }),
          );
          this.store.dispatch(new ComparisonLeadSubmitted(lead.leadId));
          void this.router.navigate(['/estimate/compare']);
        },
        error: () => {
          this.status = 'error';
        },
      });
  }
}
