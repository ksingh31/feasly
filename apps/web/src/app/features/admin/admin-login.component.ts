import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { AdminAuthApiService } from './admin-auth-api.service';
import { AdminEntraAuthService } from './admin-entra-auth.service';

type MagicLinkStatus = 'idle' | 'sending' | 'sent' | 'error';
type LoginMode = 'entra' | 'magic-link';

/**
 * Admin login (auth/02 pivot): Microsoft Entra External ID.
 *
 * The card keeps the admin design language (warm cream page, centered
 * white card, brass primary button). The single "Sign in →" button starts
 * the Microsoft-hosted flow via `AdminEntraAuthService.startSignIn()`
 * (PKCE + state, verifier kept in sessionStorage); Entra redirects back
 * to `/admin/auth/callback`, which exchanges the code with the backend.
 * The SPA never sees Entra tokens.
 *
 * The magic-link flow is NOT removed: it stays available behind the
 * "Use a sign-in link instead" toggle while the backend keeps the routes
 * live. AUTH-06 retires it. `/admin/verify` is untouched.
 *
 * Query params:
 * - `expired=1` — shows the session-expired copy.
 *
 * Signals, not plain fields: the app runs zoneless change detection, so
 * status writes inside HTTP callbacks must be signals to re-render.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-admin-login',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './admin-login.component.html',
  styleUrls: ['./admin-login.component.scss'],
})
export class AdminLoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(AdminAuthApiService);
  private readonly entra = inject(AdminEntraAuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);
  /**
   * Buyer-grade login copy (ConfigService, `copy.admin.auth`) — exact
   * story wording, deploy-tunable, keeps the no-hardcode tripwire green.
   */
  protected readonly copy = inject(ConfigService).get('copy').admin.auth;

  /** Legacy magic-link form (kept while the backend flag stays on). */
  protected readonly magicLinkForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected readonly mode = signal<LoginMode>('entra');
  protected readonly entraStarting = signal(false);
  /** False while the deployed app-config still carries ENTRA_* placeholders. */
  protected readonly entraConfigured = this.entra.isConfigured();
  protected readonly magicLinkStatus = signal<MagicLinkStatus>('idle');

  protected showExpired = false;

  constructor() {
    this.showExpired = this.route.snapshot.queryParamMap.get('expired') === '1';
    this.seo.setPage({
      title: 'Admin sign in — Feasly',
      description: 'Feasly admin sign in.',
      path: '/admin/login',
    });
  }

  /**
   * Start the Microsoft-hosted sign-in. The redirect unloads the page, so
   * `entraStarting` only resets when the redirect itself throws (e.g.
   * `crypto.subtle` unavailable outside a secure context).
   */
  protected async startEntraSignIn(): Promise<void> {
    if (!this.entraConfigured || this.entraStarting()) return;
    this.entraStarting.set(true);
    try {
      await this.entra.startSignIn();
    } catch {
      this.entraStarting.set(false);
    }
  }

  protected submitMagicLink(): void {
    if (this.magicLinkForm.invalid || this.magicLinkStatus() === 'sending') return;
    this.magicLinkStatus.set('sending');
    const email = this.magicLinkForm.controls.email.value.trim();
    this.api
      .requestMagicLink({ email })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.magicLinkStatus.set('sent');
        },
        error: () => {
          this.magicLinkStatus.set('error');
        },
      });
  }

  protected retryMagicLink(): void {
    this.magicLinkStatus.set('idle');
  }

  protected get magicLinkEmailInvalid(): boolean {
    const control = this.magicLinkForm.controls.email;
    return control.invalid && (control.dirty || control.touched);
  }
}
