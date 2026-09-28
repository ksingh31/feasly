import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { AdminAuthApiService } from './admin-auth-api.service';
import { LoginAdminWithPassword } from './admin-auth.actions';
import { AdminAuthState, type LoginErrorKind } from './admin-auth.state';

type PasswordStatus = 'idle' | 'submitting';
type MagicLinkStatus = 'idle' | 'sending' | 'sent' | 'error';
type LoginMode = 'password' | 'magic-link';

/**
 * Buyer-grade inline copy for each password-login failure kind.
 * Exact wording from the auth/02 story — do not rephrase without a story
 * update. 401 never reveals whether the email exists (no oracle).
 */
const LOGIN_ERROR_COPY: Record<LoginErrorKind, string> = {
  'invalid-credentials': "We don't recognize that email/password combination.",
  'rate-limited': 'Too many attempts — try again in 15 minutes.',
  transient: 'Something went wrong. Please try again.',
};

/**
 * Admin login (auth/02): password-first sign in.
 *
 * The password form posts to `POST /api/v1/admin/auth/login` via the
 * `LoginAdminWithPassword` NGXS action (contract-driven — the backend
 * route lands separately). Inline errors come from
 * `AdminAuthState.lastLoginError`; on success the guard's probe takes over
 * and we land on `/admin`.
 *
 * The magic-link flow is NOT removed: it stays available behind the
 * "Use a sign-in link instead" toggle while the backend keeps the routes
 * live (`admin.auth.magicLinkEnabled`, auth/02 story). AUTH-06 retires it.
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
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './admin-login.component.html',
  styleUrls: ['./admin-login.component.scss'],
})
export class AdminLoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(AdminAuthApiService);
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
    rememberMe: [true],
  });

  /** Legacy magic-link form (kept while the backend flag stays on). */
  protected readonly magicLinkForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected readonly mode = signal<LoginMode>('password');
  protected readonly passwordStatus = signal<PasswordStatus>('idle');
  protected readonly magicLinkStatus = signal<MagicLinkStatus>('idle');
  protected readonly showPassword = signal(false);
  protected readonly lastLoginError =
    this.store.selectSignal(AdminAuthState.lastLoginError);

  protected showExpired = false;

  constructor() {
    this.showExpired =
      this.route.snapshot.queryParamMap.get('expired') === '1';
    this.seo.setPage({
      title: 'Admin sign in — Feasly',
      description: 'Feasly admin sign in.',
      path: '/admin/login',
    });
  }

  protected submitPassword(): void {
    if (this.form.invalid || this.passwordStatus() === 'submitting') return;
    this.passwordStatus.set('submitting');
    const { email, password, rememberMe } = this.form.getRawValue();
    this.store
      .dispatch(
        new LoginAdminWithPassword(email.trim(), password, rememberMe),
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.passwordStatus.set('idle');
        if (this.store.selectSnapshot(AdminAuthState.authenticated)) {
          void this.router.navigate(['/admin']);
        }
        // Otherwise lastLoginError renders the inline error — the user
        // keeps their place and can retry immediately.
      });
  }

  protected submitMagicLink(): void {
    if (this.magicLinkForm.invalid || this.magicLinkStatus() === 'sending')
      return;
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

  protected togglePasswordVisibility(): void {
    this.showPassword.update((v) => !v);
  }

  protected loginErrorText(): string | null {
    const kind = this.lastLoginError();
    return kind === null ? null : LOGIN_ERROR_COPY[kind];
  }

  protected get emailInvalid(): boolean {
    const control = this.form.controls.email;
    return control.invalid && (control.dirty || control.touched);
  }

  protected get passwordInvalid(): boolean {
    const control = this.form.controls.password;
    return control.invalid && (control.dirty || control.touched);
  }

  protected get magicLinkEmailInvalid(): boolean {
    const control = this.magicLinkForm.controls.email;
    return control.invalid && (control.dirty || control.touched);
  }
}
