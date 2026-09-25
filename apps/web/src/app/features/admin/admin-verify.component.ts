import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { SeoService } from '../../core/seo/seo.service';
import { AdminAuthApiService } from './admin-auth-api.service';

type VerifyStatus = 'verifying' | 'error';

/**
 * Admin magic-link verification (admin/01).
 *
 * Route: `/admin/verify?token=…` (linked from the email). On success the
 * backend sets the `feasly_admin_session` HttpOnly cookie and we land on
 * `/admin/leads`. On failure (expired/used/invalid token) we redirect to
 * `/admin/login` — the uniform 401 gives no detail to surface.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-admin-verify',
  standalone: true,
  templateUrl: './admin-verify.component.html',
  styleUrls: ['./admin-login.component.scss'],
})
export class AdminVerifyComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(AdminAuthApiService);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  protected status: VerifyStatus = 'verifying';

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
    this.api
      .verifyMagicLink(token)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          // Cookie is set by the backend; land on the admin area.
          void this.router.navigate(['/admin/leads']);
        },
        error: () => {
          this.status = 'error';
        },
      });
  }

  protected toLogin(): void {
    void this.router.navigate(['/admin/login']);
  }
}
