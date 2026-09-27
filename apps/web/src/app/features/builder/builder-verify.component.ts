import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { VerifyBuilderToken } from './builder.actions';
import { BuilderState } from './builder.state';

type VerifyStatus = 'verifying' | 'error';

/**
 * Builder magic-link verification (embed/09). Mirrors admin/01.
 *
 * Route: `/builder/verify?token=…` (linked from the email). On success the
 * session token (from the verify JSON body) is stored in BuilderState and
 * we land on `/builder`; subsequent builder API calls carry it as
 * `Authorization: Bearer <token>` via the credentials interceptor. On
 * failure (expired/used/invalid token) we show the error copy with a link
 * back to `/builder/login`.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-builder-verify',
  standalone: true,
  templateUrl: './builder-verify.component.html',
  styleUrls: ['../admin/admin-login.component.scss'],
})
export class BuilderVerifyComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(ConfigService).get('copy').builder;

  protected status: VerifyStatus = 'verifying';

  constructor() {
    this.seo.setPage({
      title: 'Verifying sign in — Feasly',
      description: 'Verifying your Feasly builder sign-in link.',
      path: '/builder/verify',
    });
  }

  ngOnInit(): void {
    const token = this.route.snapshot.queryParamMap.get('token') ?? '';
    if (!token) {
      this.toLogin();
      return;
    }
    this.store
      .dispatch(new VerifyBuilderToken(token))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.store.selectSnapshot(BuilderState.authenticated)) {
          // Session token is stored in BuilderState; land on the portal.
          void this.router.navigate(['/builder']);
        } else {
          this.status = 'error';
        }
      });
  }

  protected toLogin(): void {
    void this.router.navigate(['/builder/login']);
  }
}
