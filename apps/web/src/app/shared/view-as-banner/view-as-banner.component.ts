import { Component, EventEmitter, Input, Output } from '@angular/core';

/**
 * Banner model for the shared view-as banner. Display only — the backend
 * resolves permissions and tenant scoping from the session's view-as
 * state; the frontend never gates anything on this.
 *
 * `displayName` is the target's name; it is null when the target no
 * longer resolves (unknown/disabled) — the banner then shows "no longer
 * available" copy with the exit.
 */
export interface ViewAsBannerModel {
  readonly displayName: string | null;
  readonly realEmail: string | null;
}

/**
 * Shared view-as banner (auth/04, reused by the builder portal for
 * builder-side view-as, 2026-09-30).
 *
 * Persistent banner pinned to the top of the shell while the session is
 * viewing-as someone else: "Viewing as X — Exit". Dumb component: the
 * host shell supplies the banner model (from its NGXS selector) and
 * handles the exit event (dispatching its own exit action). Both the
 * admin and builder shells reuse this — the copy is deliberately portal-
 * neutral.
 */
@Component({
  selector: 'app-view-as-banner',
  standalone: true,
  templateUrl: './view-as-banner.component.html',
  styleUrls: ['./view-as-banner.component.scss'],
})
export class ViewAsBannerComponent {
  /** Null when the session is not viewing-as — the banner hides. */
  @Input() banner: ViewAsBannerModel | null = null;

  /** The user clicked Exit. */
  @Output() readonly exit = new EventEmitter<void>();

  protected exitViewAs(): void {
    this.exit.emit();
  }
}
