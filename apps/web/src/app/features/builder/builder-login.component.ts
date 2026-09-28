import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { BuilderEntraAuthService } from './builder-entra-auth.service';

/**
 * Builder login page (auth/05, builder org accounts).
 *
 * Route: `/builder/login`. The magic-link form is gone — sign-in runs
 * through Microsoft Entra External ID: a single "Sign in with Microsoft →"
 * button starts the Microsoft-hosted flow (PKCE + state via
 * `BuilderEntraAuthService`), and Entra returns to
 * `/builder/auth/callback`.
 *
 * While the app-config still carries ENTRA_BUILDER_* placeholders
 * (`entra.isConfigured()` false), the button is replaced with the
 * buyer-grade `entraNotConfigured` line — the portal never renders a
 * sign-in control it can't honor. `?expired=1` shows the exact
 * session-expired copy.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-builder-login',
  standalone: true,
  templateUrl: './builder-login.component.html',
  styleUrls: ['./builder-login.component.scss'],
})
export class BuilderLoginComponent {
  protected readonly entra = inject(BuilderEntraAuthService);
  protected readonly seo = inject(SeoService);
  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(ConfigService).get('copy').builder;

  protected readonly showExpired =
    inject(ActivatedRoute).snapshot.queryParamMap.get('expired') === '1';
  protected readonly redirecting = signal(false);

  constructor() {
    this.seo.setPage({
      title: 'Builder sign in — Feasly',
      description: 'Sign in to your Feasly builder portal.',
      path: '/builder/login',
    });
  }

  protected signIn(): void {
    this.redirecting.set(true);
    void this.entra.startSignIn();
  }
}
