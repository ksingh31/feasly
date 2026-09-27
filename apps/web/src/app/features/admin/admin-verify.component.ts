import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { AdminAuthApiService } from './admin-auth-api.service';
import { AdminAuthState, type VerifyErrorKind } from './admin-auth.state';
import { VerifyAdminToken } from './admin-auth.actions';

type VerifyStatus = 'confirm' | 'verifying' | 'error';
type ResendStatus = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Admin magic-link verification (admin/01).
 *
 * Route: `/admin/verify?token=…` (linked from the email). The token is
 * SINGLE-USE server-side, so we do NOT verify on page load: email
 * link-scanners and prefetchers would otherwise burn the token before
 * the human taps it (goal_169560defa2b). Instead we render a
 * one-tap interstitial ("Sign me in →") and dispatch VerifyAdminToken
 * only on that click. On success the session token (from the verify JSON
 * body) is stored in AdminAuthState and we land on `/admin/leads`;
 * subsequent admin API calls carry it as `Authorization: Bearer <token>`
 * via the credentials interceptor.
 *
 * Error states (goals goal_e0c7c0e53a2b / goal_c6482fb6090a): the failure
 * kind comes from `AdminAuthState.lastVerifyError` (classified in the
 * state, not here) so the page shows the right copy —
 * already-used vs invalid/expired vs transient — instead of one generic
 * message. Used/invalid links get an inline "Send me a fresh link" form
 * (the verify URL carries no email, so we ask for it here); transient
 * failures get a Retry button that re-fires the same token.
 *
 * `status`/`errorKind`/`resendStatus` are signals, not plain fields: the
 * app runs zoneless change detection (no zone.js), so a plain-field write
 * inside the HTTP callbacks would never re-render — the page would sit on
 * "verifying" forever (P0).
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-admin-verify',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './admin-verify.component.html',
  styleUrls: ['./admin-login.component.scss'],
})
export class AdminVerifyComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly store = inject(Store);
  private readonly api = inject(AdminAuthApiService);
  private readonly fb = inject(FormBuilder);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly status = signal<VerifyStatus>('confirm');
  protected readonly errorKind = signal<VerifyErrorKind>('invalid');
  protected readonly resendStatus = signal<ResendStatus>('idle');
  protected readonly resendForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });
  protected displayEmail = 'admin';
  private token = '';

  constructor() {
    this.seo.setPage({
      title: 'Verifying sign in — Feasly',
      description: 'Verifying your Feasly admin sign-in link.',
      path: '/admin/verify',
    });
  }

  ngOnInit(): void {
    const token = this.route.snapshot.queryParamMap.get('token') ?? '';
    if (!token) {
      this.toLogin();
      return;
    }
    this.token = token;
    this.displayEmail =
      this.store.selectSnapshot(AdminAuthState.email) ?? 'admin';
    // Gesture gate: do NOT fire the verify request on load. Only the
    // user's tap below consumes the single-use token.
    this.status.set('confirm');
  }

  /** Fires the single-use token verification — only on explicit user tap. */
  protected signIn(): void {
    if (this.status() !== 'confirm') {
      return;
    }
    this.fireVerify();
  }

  /** Re-fires verification after a transient failure (same token). */
  protected retry(): void {
    if (this.status() !== 'error' || this.errorKind() !== 'transient') {
      return;
    }
    this.fireVerify();
  }

  private fireVerify(): void {
    this.status.set('verifying');
    this.store
      .dispatch(new VerifyAdminToken(this.token))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.store.selectSnapshot(AdminAuthState.authenticated)) {
          void this.router.navigate(['/admin/leads']);
        } else {
          this.errorKind.set(readVerifyErrorKind(this.store));
          this.status.set('error');
        }
      });
  }

  /** Sends a fresh magic link to the entered email (error state only). */
  protected resend(): void {
    if (this.resendForm.invalid || this.resendStatus() === 'sending') {
      return;
    }
    this.resendStatus.set('sending');
    const email = this.resendForm.controls.email.value.trim();
    this.api
      .requestMagicLink({ email })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.resendStatus.set('sent'),
        error: () => this.resendStatus.set('error'),
      });
  }

  protected get resendEmailInvalid(): boolean {
    const control = this.resendForm.controls.email;
    return control.invalid && (control.dirty || control.touched);
  }

  protected toLogin(): void {
    void this.router.navigate(['/admin/login']);
  }
}

/**
 * Reads the classified verify failure from state, defaulting to 'invalid'
 * for anything unexpected (e.g. a state shape from an older persisted
 * slice).
 */
function readVerifyErrorKind(store: Store): VerifyErrorKind {
  const kind = store.selectSnapshot(AdminAuthState.lastVerifyError);
  return kind === 'used' || kind === 'transient' ? kind : 'invalid';
}
