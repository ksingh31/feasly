import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import type { AbstractControl } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { map, switchMap } from 'rxjs';
import type { TimelineOption } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent, WizardStepsComponent } from '../../shared/components';
import { GoToStep, StoreLeadResult, WizardState } from '../wizard';
import { AnalyticsService } from '../consent';

type GateStatus = 'idle' | 'sending' | 'error';

/**
 * Lead gate (FE-004): the single gate in the flow.
 *
 * Name + email required, phone + timeline optional, CASL opt-in unchecked by
 * default. On submit the component first runs the preview estimate — the lead
 * contract requires an `estimateId`, so this real call mints it — then POSTs
 * the lead and routes to the analyzing screen. Loading and honest error
 * states included; the error banner retries the whole submit.
 *
 * ID consistency note: the analyzing screen re-runs the same estimate with
 * identical inputs. The mock harness derives a deterministic estimateId from
 * the inputs, so the lead stays linked to the preview the user will see.
 * The real API is not wired for this flow yet: it has no /estimates/preview
 * endpoint, and POST /estimates mints a fresh random UUID per call. When the
 * real backend takes over, the estimate endpoint must become idempotent
 * (deterministic ID from canonical inputs + cost-data version, skipping
 * duplicate inserts) or the analyzing screen must reuse the gate's preview
 * instead of re-minting — otherwise the lead attaches to a different
 * persisted row than the one the user viewed.
 */
@Component({
  selector: 'app-gate-page',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    SiteFooterComponent,
    SiteNavComponent,
    WizardStepsComponent,
  ],
  templateUrl: './gate-page.component.html',
  styleUrls: ['./wizard-shell.scss', './gate-page.component.scss'],
})
export class GatePageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly api = inject(API_SERVICE);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly analytics = inject(AnalyticsService);

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
    timeline: ['' as TimelineOption | ''],
    // CASL opt-in: unchecked by default, always the user's explicit choice.
    casl: [false],
  });

  protected status: GateStatus = 'idle';

  ngOnInit(): void {
    this.seo.setPage({
      title: this.config.get('copy').seo.gateTitle,
      description: this.config.get('copy').seo.gate,
      path: '/estimate/gate',
    });
  }

  /** True when the control is invalid and the user has interacted or submitted. */
  showError(controlName: 'name' | 'email' | 'phone'): boolean {
    const control = this.form.get(controlName);
    return !!control && control.invalid && (control.touched || control.dirty);
  }

  goBack(): void {
    this.store.dispatch(new GoToStep(2));
    void this.router.navigate(['/estimate/scope']);
  }

  onSubmit(): void {
    if (this.status === 'sending') {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
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
    // The lead must reference an estimate: mint the estimateId with a real
    // preview call first. The analyzing screen re-runs the full pipeline
    // visibly right after this.
    this.api
      .getPreviewEstimate({ addressKey: property.addressKey, ...inputs })
      .pipe(
        switchMap((preview) =>
          this.api
            .submitLead({
              estimateId: preview.estimateId,
              name: values.name.trim(),
              email: values.email.trim(),
              phone: values.phone.trim() === '' ? undefined : values.phone.trim(),
              timeline: values.timeline === '' ? 'exploring' : values.timeline,
              marketingConsent: values.casl,
            })
            .pipe(map((lead) => ({ lead, email: values.email.trim() }))),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ({ lead, email }) => {
          // The gate converted: consent-gated inside AnalyticsService, so a
          // declined/pending banner means this is a silent no-op.
          this.analytics.track('gate_convert');
          this.store.dispatch(
            new StoreLeadResult({
              leadId: lead.leadId,
              email,
              magicLinkSent: lead.magicLinkSent,
              expiresInDays: lead.expiresInDays,
            }),
          );
          void this.router.navigate(['/estimate/analyzing']);
        },
        error: () => {
          this.status = 'error';
        },
      });
  }
}
