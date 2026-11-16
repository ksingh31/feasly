import { Dialog } from '@angular/cdk/dialog';
import { Component, ElementRef, afterNextRender, inject, input, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { UiButtonComponent } from '@app/shared/ui';
import { BUILDER_COPY } from './builder-copy';

/**
 * #861: "Your account is paused — contact Feasly". The builder shell shows
 * this instead of the page when the API refuses a call with 403
 * BUILDER_PAUSED (org suspended, offboarding or closed) — never a generic
 * error. Owners get a way to their invoices (still viewable and payable
 * while suspended); everyone gets the Help tab with the support contact.
 *
 * Takes focus on render and closes any open drawer/modal so nothing sits
 * on top of it. Every string comes from BUILDER_COPY.
 */
@Component({
  selector: 'app-builder-paused',
  standalone: true,
  imports: [RouterLink, UiButtonComponent],
  templateUrl: './builder-paused.component.html',
  styleUrl: './builder-paused.component.scss',
})
export class BuilderPausedComponent {
  /** The server's message (null = the copy default). */
  readonly message = input<string | null>(null);
  /** Org owner: show the invoices note + link. */
  readonly isAdmin = input(false);

  protected readonly copy = inject(BUILDER_COPY).paused;
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  constructor() {
    inject(Dialog).closeAll();
    afterNextRender(() => this.heading().nativeElement.focus());
  }
}
