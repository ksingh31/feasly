import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { BrandMarkComponent } from '../../shared/components/brand-mark';
import { LogoutAdmin } from './admin-auth.actions';
import { AdminAuthState } from './admin-auth.state';
import { ExitViewAs } from './admin-auth.actions';
import { AdminEntraAuthService } from './admin-entra-auth.service';
import { ViewAsBannerComponent } from '../../shared/view-as-banner';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';

/**
 * Admin shell (admin/01): layout for the guarded `/admin` route group.
 * Includes sign-out. The actual admin pages (leads, etc.) land in later
 * stories; this shell provides the authenticated frame.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-admin-shell',
  standalone: true,
  imports: [BrandMarkComponent, RouterLink, RouterOutlet, ViewAsBannerComponent],
  templateUrl: './admin-shell.component.html',
  styleUrls: ['./admin-shell.component.scss'],
})
export class AdminShellComponent {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly entraAuth = inject(AdminEntraAuthService);

  /** Mobile nav menu open state. Desktop shows the nav inline. */
  protected readonly menuOpen = signal(false);

  /**
   * API-keys management is a write surface (`api_keys:manage`) — read-only
   * staff (viewers) don't get the nav link. Every other section is
   * readable by every staff role; write actions inside them are gated
   * individually.
   */
  protected readonly canManageApiKeys = adminCan(
    this.store,
    ADMIN_PERMISSIONS.apiKeysManage,
  );

  constructor() {
    // Admin console titles (admin/07) are driven centrally from the
    // seo-routes table on every completed navigation: section components
    // must NOT set their own titles. NavigationEnd fires after the
    // incoming section's component is created, so this always wins over
    // any stale per-section title and covers sections that never set one
    // (previously /admin/billing inherited "Disputes — Feasly Admin" and
    // /admin/builders fell through to the 404 title).
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        // Close the mobile menu whenever navigation completes.
        this.menuOpen.set(false);
        this.seo.setForRoute(event.urlAfterRedirects);
      });
  }

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  /** View-as banner model (null when the session is not viewing-as). */
  protected readonly viewAsBanner = this.store.selectSignal(
    AdminAuthState.viewAsBanner,
  );

  protected exitViewAs(): void {
    this.store
      .dispatch(new ExitViewAs())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected signOut(): void {
    this.store
      .dispatch(new LogoutAdmin())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          // When the Entra end-session redirect fired, the browser is
          // already leaving for the IdP (which redirects back to
          // /admin/login) — skip the in-app navigation.
          if (!this.entraAuth.consumeSignOutRedirect()) {
            void this.router.navigate(['/admin/login']);
          }
        },
        error: () => void this.router.navigate(['/admin/login']),
      });
  }
}
