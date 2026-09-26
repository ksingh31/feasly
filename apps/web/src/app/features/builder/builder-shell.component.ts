import { Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { LogoutBuilder } from './builder.actions';
import { BuilderState } from './builder.state';

/**
 * Builder shell (embed/09): layout for the guarded `/builder` route group.
 * Shows the signed-in builder's email and a sign-out action; the dashboard
 * (pipeline list + summary) renders in the outlet.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-builder-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './builder-shell.component.html',
  styleUrls: ['./builder-shell.component.scss'],
})
export class BuilderShellComponent {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(ConfigService).get('copy').builder;

  protected readonly session = this.store.selectSignal(BuilderState.session);

  constructor() {
    this.seo.setPage({
      title: 'Builder portal — Feasly',
      description: 'Feasly builder lead pipeline.',
      path: '/builder',
    });
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
