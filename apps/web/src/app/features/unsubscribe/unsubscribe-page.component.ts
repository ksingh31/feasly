import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { ApiError } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { SiteNavComponent } from '../../shared/components/site-nav/site-nav.component';

/**
 * Unsubscribe center (email/03): `/unsubscribe/{token}`.
 *
 * Token-authenticated — no login. The token IS the credential: it is never
 * logged, never rendered, and the lead's email is never exposed to the
 * client (the backend returns a leadId only, which this page never displays).
 *
 * States: loading → confirm (valid token) | already (opted out) |
 * expired | invalid → done (after POST). Transport failures show a retry
 * screen. The page is noindexed via the route's `data.noindex` + the
 * `unsubscribe/:token` SeoService entry.
 */
type UnsubscribeView =
  | 'loading'
  | 'confirm'
  | 'done'
  | 'already'
  | 'expired'
  | 'invalid'
  | 'error';

@Component({
  selector: 'app-unsubscribe-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './unsubscribe-page.component.html',
  styleUrl: './unsubscribe-page.scss',
})
export class UnsubscribePageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_SERVICE);
  private readonly config = inject(ConfigService);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copy = this.config.get('copy').unsubscribe;
  protected readonly view = signal<UnsubscribeView>('loading');
  protected readonly submitting = signal(false);

  private token = '';

  ngOnInit(): void {
    this.token = this.route.snapshot.paramMap.get('token')?.trim() ?? '';
    this.seo.setForRoute(`unsubscribe/${this.token || 'unknown'}`);
    this.loadState();
  }

  protected confirm(): void {
    if (this.submitting()) {
      return;
    }
    this.submitting.set(true);
    this.api
      .confirmUnsubscribe(this.token)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.submitting.set(false);
          this.view.set('done');
        },
        error: () => {
          this.submitting.set(false);
          this.view.set('error');
        },
      });
  }

  protected retry(): void {
    this.loadState();
  }

  protected keepSubscribed(): void {
    void this.router.navigate(['/']);
  }

  private loadState(): void {
    if (!this.token) {
      this.view.set('invalid');
      return;
    }
    this.view.set('loading');
    this.api
      .getUnsubscribeState(this.token)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (state) => {
          // NOTE: `state.valid === false` (not `!state.valid`) — without
          // strictNullChecks, TS does not narrow the negated boolean
          // discriminant (see mock-api.service.spec.ts).
          if (state.valid === false) {
            this.view.set(state.reason === 'expired' ? 'expired' : 'invalid');
          } else {
            this.view.set(state.alreadyUnsubscribed ? 'already' : 'confirm');
          }
        },
        error: (err: ApiError) => {
          // The backend answers 403 FORBIDDEN for forged tokens (no oracle);
          // surface that as the invalid-link screen, not a transport error.
          this.view.set(err?.code === 'FORBIDDEN' ? 'invalid' : 'error');
        },
      });
  }
}
