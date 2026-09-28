import { Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { AdminAuthState } from '../admin-auth.state';
import { ExitViewAs } from '../admin-auth.actions';

/**
 * View-as banner (auth/04).
 *
 * Persistent banner pinned to the top of the admin shell while the session
 * is viewing-as another builder or user: "Viewing as X — Exit". The
 * banner is DISPLAY ONLY — the backend resolves permissions and tenant
 * scoping from the session's view-as state; the frontend never gates
 * anything on this.
 */
@Component({
  selector: 'app-view-as-banner',
  standalone: true,
  templateUrl: './view-as-banner.component.html',
  styleUrls: ['./view-as-banner.component.scss'],
})
export class ViewAsBannerComponent {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  /** Null when the session is not viewing-as — the banner hides. */
  protected readonly banner = this.store.selectSignal(
    AdminAuthState.viewAsBanner,
  );

  protected exitViewAs(): void {
    this.store
      .dispatch(new ExitViewAs())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }
}
