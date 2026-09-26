import { Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { BuilderAuthApiService } from './builder-auth-api.service';

type LoginStatus = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Builder login (embed/09): email → magic link. No passwords.
 *
 * Mirrors the admin/01 login. The request always returns `{ sent: true }` —
 * the UI shows the "check your email" copy whether or not the address is
 * allowlisted (no enumeration oracle).
 *
 * Query params:
 * - `expired=1` — shows the session-expired copy.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-builder-login',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './builder-login.component.html',
  styleUrls: ['../admin/admin-login.component.scss', './builder-login.component.scss'],
})
export class BuilderLoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(BuilderAuthApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(ConfigService).get('copy').builder;

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected status: LoginStatus = 'idle';
  protected showExpired = false;

  constructor() {
    this.showExpired =
      this.route.snapshot.queryParamMap.get('expired') === '1';
    this.seo.setPage({
      title: 'Builder sign in — Feasly',
      description: 'Feasly builder portal sign in.',
      path: '/builder/login',
    });
  }

  protected submit(): void {
    if (this.form.invalid || this.status === 'sending') return;
    this.status = 'sending';
    const email = this.form.controls.email.value.trim();
    this.api
      .requestMagicLink({ email })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.status = 'sent';
        },
        error: () => {
          this.status = 'error';
        },
      });
  }

  protected retry(): void {
    this.status = 'idle';
  }

  protected get emailInvalid(): boolean {
    const control = this.form.controls.email;
    return control.invalid && (control.dirty || control.touched);
  }
}
