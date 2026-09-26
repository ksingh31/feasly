import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { SeoService } from '../../core/seo/seo.service';
import { AdminAuthApiService } from './admin-auth-api.service';

type LoginStatus = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Admin login (admin/01): email → magic link. No passwords.
 *
 * The request always returns `{ sent: true }` — the UI shows
 * "Check your email for your sign-in link." whether or not the address is
 * allowlisted (no enumeration oracle).
 *
 * `status` is a signal, not a plain field: the app runs zoneless change
 * detection (no zone.js), so the 'sent'/'error' writes inside the HTTP
 * callbacks must be signals to re-render (same P0 class as the verify
 * page hang — a plain-field write there never updated the UI).
 *
 * Query params:
 * - `expired=1` — shows the session-expired copy:
 *   "Your admin session expired. Enter your email for a fresh sign-in link."
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
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected readonly status = signal<LoginStatus>('idle');
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

  protected submit(): void {
    if (this.form.invalid || this.status() === 'sending') return;
    this.status.set('sending');
    const email = this.form.controls.email.value.trim();
    this.api
      .requestMagicLink({ email })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.status.set('sent');
        },
        error: () => {
          this.status.set('error');
        },
      });
  }

  protected retry(): void {
    this.status.set('idle');
  }

  protected get emailInvalid(): boolean {
    const control = this.form.controls.email;
    return control.invalid && (control.dirty || control.touched);
  }
}
