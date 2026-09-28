import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { AdminEntraAuthService } from './admin-entra-auth.service';

/**
 * Admin login (auth/02): Microsoft Entra External ID — the only admin
 * sign-in. The legacy magic-link flow was retired 2026-09-28 (Karan).
 *
 * The card keeps the admin design language (warm cream page, centered
 * white card, brass primary button). The single "Sign in →" button starts
 * the Microsoft-hosted flow via `AdminEntraAuthService.startSignIn()`
 * (PKCE + state, verifier kept in sessionStorage); Entra redirects back
 * to `/admin/auth/callback`, which exchanges the code with the backend.
 * The SPA never sees Entra tokens.
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
  templateUrl: './admin-login.component.html',
  styleUrls: ['./admin-login.component.scss'],
})
export class AdminLoginComponent {
  private readonly entra = inject(AdminEntraAuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly seo = inject(SeoService);
  /**
   * Buyer-grade login copy (ConfigService, `copy.admin.auth`) — exact
   * story wording, deploy-tunable, keeps the no-hardcode tripwire green.
   */
  protected readonly copy = inject(ConfigService).get('copy').admin.auth;

  protected readonly entraStarting = signal(false);
  /** False while the deployed app-config still carries ENTRA_* placeholders. */
  protected readonly entraConfigured = this.entra.isConfigured();

  protected showExpired = false;

  constructor() {
    this.showExpired = this.route.snapshot.queryParamMap.get('expired') === '1';
    this.seo.setPage({
      title: 'Admin sign in — Feasly',
      description: 'Feasly admin sign in.',
      path: '/admin/login',
    });
  }

  /**
   * Start the Microsoft-hosted sign-in. The redirect unloads the page, so
   * `entraStarting` only resets when the redirect itself throws (e.g.
   * `crypto.subtle` unavailable outside a secure context).
   */
  protected async startEntraSignIn(): Promise<void> {
    if (!this.entraConfigured || this.entraStarting()) return;
    this.entraStarting.set(true);
    try {
      await this.entra.startSignIn();
    } catch {
      this.entraStarting.set(false);
    }
  }
}
