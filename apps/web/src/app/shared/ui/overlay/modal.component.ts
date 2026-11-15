import { DialogRef } from '@angular/cdk/dialog';
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewEncapsulation,
  booleanAttribute,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { UI_MODAL_CONTEXT } from './modal.service';

/** Share of the sheet's height a downward drag must pass to dismiss it. */
const SWIPE_DISMISS_FRACTION = 4;

/**
 * Modal shell (`ui-modal`) — portal-ui-kit §3. The chrome for content
 * opened with {@link UiModalService}: header (title), scrolling body,
 * sticky footer, close ×. Centred `sm`/`md`/`lg` on desktop; a bottom
 * sheet with a drag handle and safe-area padding below 768px.
 *
 * ```html
 * <ui-modal heading="Change commission rate" asForm (submitted)="save()">
 *   <ui-text-field label="Rate" … />
 *   <ng-container uiModalFooter>
 *     <button type="button" ui-button variant="secondary" (click)="ref.close()">Cancel</button>
 *     <button type="submit" ui-button [disabled]="form.invalid">Save</button>
 *   </ng-container>
 * </ui-modal>
 * ```
 *
 * `asForm` wraps body + footer in a `<form>`, so Enter submits — and only
 * when valid, because a disabled submit button blocks implicit submission.
 *
 * Styles are unencapsulated (`ui-modal*` prefixed) because the CDK pane and
 * scrim live outside any component's view.
 */
@Component({
  selector: 'ui-modal',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './modal.component.html',
  styleUrl: './modal.component.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ui-modal' },
})
export class UiModalComponent {
  readonly heading = input.required<string>();
  /** Show the × button. */
  readonly closable = input(true, { transform: booleanAttribute });
  /** Wrap body + footer in a form; Enter emits `submitted`. */
  readonly asForm = input(false, { transform: booleanAttribute });
  readonly closeLabel = input('Close');

  /** The form was submitted (asForm only). */
  readonly submitted = output<void>();

  private readonly ref = inject(DialogRef, { optional: true });
  private readonly context = inject(UI_MODAL_CONTEXT, { optional: true });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly titleId = this.context?.titleId ?? null;
  protected readonly bodyId = this.context?.bodyId ?? null;
  protected readonly swipeable = this.context?.dismissOnScrim ?? false;

  /** Current downward drag of the sheet, px. */
  protected readonly dragOffset = signal(0);
  protected readonly dragTransform = computed(() =>
    this.dragOffset() > 0 ? `translateY(${this.dragOffset()}px)` : null,
  );
  private dragStartY: number | null = null;

  close(): void {
    this.ref?.close();
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    this.submitted.emit();
  }

  protected onHandleDown(event: PointerEvent): void {
    if (!this.swipeable) return;
    this.dragStartY = event.clientY;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  protected onHandleMove(event: PointerEvent): void {
    if (this.dragStartY === null) return;
    this.dragOffset.set(Math.max(0, event.clientY - this.dragStartY));
  }

  protected onHandleUp(): void {
    if (this.dragStartY === null) return;
    this.dragStartY = null;
    const dismiss = this.dragOffset() > this.host.offsetHeight / SWIPE_DISMISS_FRACTION;
    this.dragOffset.set(0);
    if (dismiss) this.close();
  }
}
