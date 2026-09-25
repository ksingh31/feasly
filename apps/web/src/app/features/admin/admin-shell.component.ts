import { Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { SeoService } from '../../core/seo/seo.service';
import { AdminAuthApiService } from './admin-auth-api.service';

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
  imports: [RouterLink, RouterOutlet],
  templateUrl: './admin-shell.component.html',
  styleUrls: ['./admin-shell.component.scss'],
})
export class AdminShellComponent {
  private readonly api = inject(AdminAuthApiService);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.seo.setPage({
      title: 'Admin — Feasly',
      description: 'Feasly admin.',
      path: '/admin',
    });
  }

  protected signOut(): void {
    this.api
      .logout()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => void this.router.navigate(['/admin/login']),
        error: () => void this.router.navigate(['/admin/login']),
      });
  }
}
