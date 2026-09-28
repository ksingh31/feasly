import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { BrandMarkComponent } from '../../shared/components/brand-mark';
import { LogoutAdmin } from './admin-auth.actions';
import { ViewAsBannerComponent } from './view-as-banner';

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

  /** Mobile nav menu open state. Desktop shows the nav inline. */
  protected readonly menuOpen = signal(false);

  constructor() {
    this.seo.setPage({
      title: 'Admin — Feasly',
      description: 'Feasly admin.',
      path: '/admin',
    });
    // Close the mobile menu whenever navigation completes.
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.menuOpen.set(false));
  }

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  protected signOut(): void {
    this.store
      .dispatch(new LogoutAdmin())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => void this.router.navigate(['/admin/login']),
        error: () => void this.router.navigate(['/admin/login']),
      });
  }
}
