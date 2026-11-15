import { Dialog, type DialogRef } from '@angular/cdk/dialog';
import { hasModifierKey } from '@angular/cdk/keycodes';
import type { ComponentType } from '@angular/cdk/portal';
import { Injectable, InjectionToken, type Injector, type WritableSignal, inject, signal } from '@angular/core';
import { filter, takeUntil } from 'rxjs';

export type UiModalSize = 'sm' | 'md' | 'lg';

export interface UiModalOptions<D = unknown> {
  /** Injected into the content component as `DIALOG_DATA`. */
  data?: D;
  /** `sm` 400 · `md` 560 (default) · `lg` 720. Ignored below 768px (bottom sheet). */
  size?: UiModalSize;
  /**
   * Scrim click (and swipe-down on the mobile sheet) closes the modal.
   * Default true; set false for one-time-secret modals (portal-ui-kit §3).
   */
  dismissOnScrim?: boolean;
  /** Esc closes the modal. Default true. */
  dismissOnEsc?: boolean;
  /**
   * Close guard for user dismissals (Esc, scrim, swipe, ×). Return false to
   * keep the modal open — e.g. while a payment confirmation is in flight.
   * Programmatic `ref.close()` is never blocked. The content component can
   * also lock dismissal itself with `<ui-modal [closeLocked]="…">`.
   */
  canClose?: () => boolean;
  /** `alertdialog` for confirmations; default `dialog`. */
  role?: 'dialog' | 'alertdialog';
  /** Parent injector for the content (defaults to the root injector). */
  injector?: Injector;
}

/** Per-modal wiring the shell (`ui-modal`) reads: ids and dismiss rules. */
export interface UiModalContext {
  titleId: string;
  bodyId: string;
  dismissOnScrim: boolean;
  /** Set by `ui-modal [closeLocked]`: user dismissals are ignored while true. */
  closeLocked: WritableSignal<boolean>;
  /** Whether a user dismissal (Esc, scrim, swipe, ×) may close the modal now. */
  canDismiss: () => boolean;
}

export const UI_MODAL_CONTEXT = new InjectionToken<UiModalContext>('UI_MODAL_CONTEXT');

let nextModalId = 0;

/**
 * Modal service — portal-ui-kit §3, built on the CDK Dialog (overlay,
 * focus trap, scroll block, focus return to the trigger on close).
 *
 *   const ref = modals.open<EditRateComponent, number>(EditRateComponent, { data, size: 'sm' });
 *   ref.closed.pipe(takeUntilDestroyed(destroyRef)).subscribe((rate) => …);
 *
 * The content component renders its chrome with `<ui-modal heading="…">`.
 * Focus goes to the first field (or `[cdkFocusInitial]`); the close × sits
 * last in tab order so it never takes initial focus.
 */
@Injectable({ providedIn: 'root' })
export class UiModalService {
  private readonly dialog = inject(Dialog);

  open<C, R = unknown, D = unknown>(component: ComponentType<C>, options: UiModalOptions<D> = {}): DialogRef<R, C> {
    const id = nextModalId++;
    const closeLocked = signal(false);
    const context: UiModalContext = {
      titleId: `ui-modal-title-${id}`,
      bodyId: `ui-modal-body-${id}`,
      dismissOnScrim: options.dismissOnScrim ?? true,
      closeLocked,
      canDismiss: () => !closeLocked() && (options.canClose?.() ?? true),
    };
    const role = options.role ?? 'dialog';
    const ref = this.dialog.open<R, D, C>(component, {
      data: options.data,
      role,
      ariaModal: true,
      ariaLabelledBy: context.titleId,
      // An alertdialog's body is its message; a form modal's body is not.
      ariaDescribedBy: role === 'alertdialog' ? context.bodyId : null,
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      // Esc / scrim are handled below so each can be switched off on its own.
      disableClose: true,
      panelClass: ['ui-modal-pane', `ui-modal-pane--${options.size ?? 'md'}`],
      backdropClass: 'ui-modal-scrim',
      injector: options.injector,
      providers: [{ provide: UI_MODAL_CONTEXT, useValue: context }],
    });

    if (options.dismissOnEsc ?? true) {
      ref.keydownEvents
        .pipe(
          filter((event) => event.key === 'Escape' && !hasModifierKey(event)),
          takeUntil(ref.closed),
        )
        .subscribe((event) => {
          event.preventDefault();
          if (context.canDismiss()) ref.close();
        });
    }
    if (context.dismissOnScrim) {
      ref.backdropClick.pipe(takeUntil(ref.closed)).subscribe(() => {
        if (context.canDismiss()) ref.close();
      });
    }
    return ref;
  }
}
