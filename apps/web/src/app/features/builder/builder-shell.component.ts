import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter } from 'rxjs';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { BUILDER_COPY, provideBuilderCopy } from './builder-copy';
import { BrandMarkComponent } from '../../shared/components/brand-mark';
import { LogoutBuilder } from './builder.actions';
import { BuilderState } from './builder.state';

/**
 * Builder shell (embed/09): layout for the guarded `/builder` route group.
 * Mirrors the admin shell design language — brand mark + wordmark, mobile
 * hamburger dropdown nav, inline nav on desktop (>= 768px). Shows the
 * signed-in builder's org, session email, and a sign-out action; the
 * dashboard (pipeline list + summary) renders in the outlet.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-builder-shell',
  standalone: true,
  imports: [
    BrandMarkComponent,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
  ],
  providers: [provideBuilderCopy()],
  templateUrl: './builder-shell.component.html',
  styleUrls: ['./builder-shell.component.scss'],
})
export class BuilderShellComponent {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(BUILDER_COPY);

  protected readonly session = this.store.selectSignal(BuilderState.session);
  protected readonly activeOrgName = this.store.selectSignal(
    BuilderState.activeBuilderName,
  );
  protected readonly isBuilderAdmin = this.store.selectSignal(
    BuilderState.isBuilderAdmin,
  );

  /** Mobile nav menu open state. Desktop shows the nav inline. */
  protected readonly menuOpen = signal(false);

  constructor() {
    this.seo.setPage({
      title: 'Builder portal — Feasly',
      description: 'Feasly builder lead pipeline.',
      path: '/builder',
    });
    // Close the mobile menu whenever navigation completes.
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.menuOpen.set(false);
      });
  }

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  protected signOut(): void {
    this.store
      .dispatch(new LogoutBuilder())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.router.navigate(['/builder/login']);
      });
  }
}
