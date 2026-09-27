import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { ApiError } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { SiteNavComponent } from '../../shared/components/site-nav/site-nav.component';
import { SetReportToken } from '../report/report.actions';

/**
 * Magic-link redemption (consumer/02): `/r/:token`.
 *
 * The estimate email links here. The token is verified against
 * `GET /api/v1/magic-link/verify`; on success the report token is handed to
 * the report NGXS state and we land on `/estimate/report`, which unlocks
 * itself. Expired/invalid links get an error card with a resend form
 * (`POST /api/v1/magic-link/reissue`).
 *
 * Partner-share links use the same `/r/` URL shape but there is no
 * partner-verify endpoint yet, so they land on the invalid-link card —
 * a deliberate follow-up, not silent breakage.
 *
 * `view` is a signal, not a plain field: the app runs zoneless change
 * detection (no zone.js), so a plain-field write inside the HTTP callbacks
 * would never re-render.
 *
 * noindex via the route's `data.noindex` + the `r/:token` SeoService entry;
 * never prerendered (the token is only known at click time). Lazy-loaded so
 * the page stays out of the initial bundle.
 */
type MagicLinkView = 'verifying' | 'invalid' | 'expired' | 'error';
type ResendStatus = 'idle' | 'sending' | 'sent' | 'send-error';

@Component({
  selector: 'app-magic-link-page',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './magic-link-page.component.html',
  styleUrl: './magic-link-page.component.scss',
})
export class MagicLinkPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly store = inject(Store);
  private readonly api = inject(API_SERVICE);
  private readonly config = inject(ConfigService);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copy = this.config.get('copy').magicLink;
  protected readonly view = signal<MagicLinkView>('verifying');
  protected readonly resendStatus = signal<ResendStatus>('idle');
  protected readonly resendForm = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
  });

  private token = '';

  ngOnInit(): void {
    this.token = this.route.snapshot.paramMap.get('token')?.trim() ?? '';
    this.seo.setForRoute(`r/${this.token || 'unknown'}`);
    this.verify();
  }

  protected retry(): void {
    this.verify();
  }

  protected get resendEmailInvalid(): boolean {
    const control = this.resendForm.controls.email;
    return control.touched && control.invalid;
  }

  protected resend(): void {
    if (this.resendStatus() === 'sending') {
      return;
    }
    if (this.resendForm.invalid) {
      this.resendForm.markAllAsTouched();
      return;
    }
    this.resendStatus.set('sending');
    this.api
      .reissueMagicLink({ email: this.resendForm.controls.email.value.trim() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // No address oracle: the backend answers the same shape for unknown
        // emails, so a 200 always means "check your inbox".
        next: () => this.resendStatus.set('sent'),
        error: () => this.resendStatus.set('send-error'),
      });
  }

  private verify(): void {
    if (!this.token) {
      this.view.set('invalid');
      return;
    }
    this.view.set('verifying');
    this.api
      .verifyMagicLink(this.token)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          // NOTE: `res.valid === false` (not `!res.valid`) — without
          // strictNullChecks, TS does not narrow the negated boolean
          // discriminant.
          if (res.valid === false) {
            this.view.set(res.reason === 'expired' ? 'expired' : 'invalid');
            return;
          }
          // Valid: hand the report token to the report state and land on the
          // report page — its ngOnInit dispatches UnlockReport itself.
          this.store.dispatch(new SetReportToken(res.reportToken));
          void this.router.navigate(['/estimate/report']);
        },
        error: (err: ApiError) => {
          this.view.set(err?.code === 'FORBIDDEN' ? 'invalid' : 'error');
        },
      });
  }
}
