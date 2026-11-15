import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { ApiError } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { AnalyticsService } from '../consent/analytics.service';

/** Request lifecycle for the `/my-report` form. */
export type MyReportStatus = 'idle' | 'sending' | 'sent' | 'rate-limited' | 'error';

/**
 * Find my report (#704): `/my-report`.
 *
 * A returning user on any device enters the email they used and we send a
 * fresh report link through `POST /api/v1/magic-link/reissue`. The backend
 * answers the same shape for known and unknown emails (and for its own
 * cooldown / live-link short-circuits), so every 200 lands on the same
 * neutral "sent" copy: the page is never an address oracle. HTTP 429
 * (RATE_LIMITED) gets its own wait-and-retry state; anything else is a
 * retryable error.
 *
 * noindex via the route's `data.noindex` + the `my-report` SeoService entry,
 * and disallowed in robots.txt. Lazy-loaded; shares the magic-link card
 * styles.
 */
@Component({
  selector: 'app-my-report-page',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './my-report-page.component.html',
  styleUrl: './magic-link-page.component.scss',
})
export class MyReportPageComponent implements OnInit {
  private readonly api = inject(API_SERVICE);
  private readonly config = inject(ConfigService);
  private readonly seo = inject(SeoService);
  private readonly analytics = inject(AnalyticsService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copy = this.config.get('copy').myReport;
  protected readonly status = signal<MyReportStatus>('idle');
  protected readonly form = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
  });

  ngOnInit(): void {
    this.seo.setForRoute('my-report');
  }

  protected get emailInvalid(): boolean {
    const control = this.form.controls.email;
    return control.touched && control.invalid;
  }

  protected submit(): void {
    if (this.status() === 'sending') return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.status.set('sending');
    // Consent-gated inside AnalyticsService; carries no email.
    this.analytics.track('report_link_request');
    this.api
      .reissueMagicLink({ email: this.form.controls.email.value.trim() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // `sent: false` (unknown email, live link, cooldown) reads the same
        // as `sent: true` on purpose: no address oracle.
        next: () => this.status.set('sent'),
        error: (err: ApiError) =>
          this.status.set(err?.code === 'RATE_LIMITED' ? 'rate-limited' : 'error'),
      });
  }
}
