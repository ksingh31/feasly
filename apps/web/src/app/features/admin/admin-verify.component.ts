import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { AdminAuthState } from './admin-auth.state';
import { VerifyAdminToken } from './admin-auth.actions';

type VerifyStatus = 'verifying' | 'error';

/**
 * Admin magic-link verification (admin/01).
 *
 * Route: `/admin/verify?token=…` (linked from the email). On success the
 * session token (from the verify JSON body) is stored in AdminAuthState
 * and we land on `/admin/leads`; subsequent admin API calls carry it as
 * `Authorization: Bearer <token>` via the credentials interceptor. On
 * failure (expired/used/invalid token) we show the error state below.
 *
 * `status` is a signal, not a plain field: the app runs zoneless change
 * detection (no zone.js), so a plain-field write inside the HTTP callbacks
 * would never re-render — the page would sit on "verifying" forever (P0).
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
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly status = signal<VerifyStatus>('verifying');

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
    this.store
      .dispatch(new VerifyAdminToken(token))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.store.selectSnapshot(AdminAuthState.authenticated)) {
          void this.router.navigate(['/admin/leads']);
        } else {
          this.status.set('error');
        }
      });
  }

  protected toLogin(): void {
    void this.router.navigate(['/admin/login']);
  }
}
