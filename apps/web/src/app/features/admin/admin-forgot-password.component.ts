import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { SeoService } from '../../core/seo/seo.service';
import { AdminAuthApiService } from './admin-auth-api.service';

type ForgotStatus = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Forgot password (auth/02): request a password-reset email.
 *
 * CONTRACT-DRIVEN: posts to `POST /api/v1/admin/auth/forgot-password`
 * (backend lands with auth/02). The response is always `{ sent: true }` —
 * the UI shows the "check your email" copy whether or not the address has
 * an account (no enumeration oracle).
 *
 * Zoneless: `status` is a signal so the sent/error writes re-render.
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-admin-forgot-password',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './admin-forgot-password.component.html',
  styleUrls: ['./admin-forgot-password.component.scss'],
})
export class AdminForgotPasswordComponent {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(AdminAuthApiService);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected readonly status = signal<ForgotStatus>('idle');

  constructor() {
    this.seo.setPage({
      title: 'Reset your password — Feasly',
      description: 'Request a Feasly admin password reset link.',
      path: '/admin/forgot-password',
    });
  }

  protected submit(): void {
    if (this.form.invalid || this.status() === 'sending') return;
    this.status.set('sending');
    const email = this.form.controls.email.value.trim();
    this.api
      .requestPasswordReset({ email })
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
