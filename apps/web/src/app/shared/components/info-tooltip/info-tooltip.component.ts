import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';

let infoTooltipCounter = 0;

/**
 * InfoTooltip — a shared ⓘ trigger + tooltip bubble for disabled-control
 * explainers (auth/07 last-admin protection, both portals).
 *
 * Parents render it only when the control is disabled for an informational
 * reason and pass the exact story copy via `text`. The disabled control
 * itself binds `[attr.aria-describedby]="tip?.tooltipId"` (template ref
 * `#tip="infoTooltip"`); the bubble carries `role="tooltip"`.
 *
 * Behavior: tap/click toggles (pinned open); hover opens on hover-capable
 * desktops; keyboard focus opens; Escape, outside tap/click, or toggling
 * the icon dismisses. The bubble is `position: fixed` and clamped to the
 * viewport with an above/below flip, so it never overflows on 390px mobile
 * (e.g. inside a right-side ACTIONS column).
 */
@Component({
  selector: 'app-info-tooltip',
  standalone: true,
  templateUrl: './info-tooltip.component.html',
  styleUrl: './info-tooltip.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  exportAs: 'infoTooltip',
})
export class InfoTooltipComponent implements AfterViewChecked {
  /** Tooltip body copy — the exact story wording, owned by the parent. */
  readonly text = input.required<string>();

  /** Accessible name for the ⓘ trigger button. */
  readonly label = input('Why is this unavailable?');

  /**
   * Stable id of the tooltip bubble. Parents bind the disabled control's
   * `aria-describedby` to it: `[attr.aria-describedby]="tip?.tooltipId"`.
   */
  readonly tooltipId = `info-tooltip-${++infoTooltipCounter}`;

  protected readonly open = signal(false);
  protected readonly pinned = signal(false);
  protected readonly position = signal({ top: 0, left: 0 });
  protected readonly positioned = signal(false);

  private readonly bubbleRef = viewChild<ElementRef<HTMLElement>>('bubble');
  private readonly triggerRef = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly host = inject(ElementRef<HTMLElement>);

  private suppressFocusOpen = false;
  private hoverCapable: boolean | null = null;
  private positionQueued = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    // Outside tap/click dismisses a pinned tooltip — and keeps "only one
    // tooltip open at a time" (a second trigger's click handler opens it
    // first, then this document listener closes the earlier one).
    fromEvent(document, 'click')
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe((event) => {
        if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
          this.hide();
        }
      });
    fromEvent<KeyboardEvent>(document, 'keydown')
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe((event) => {
        if (event.key === 'Escape' && this.open()) {
          this.hide();
        }
      });
    // The bubble is viewport-fixed: re-glue it to the trigger on scroll/resize.
    fromEvent(window, 'scroll', { passive: true })
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(() => this.reposition());
    fromEvent(window, 'resize')
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(() => this.reposition());
  }

  ngAfterViewChecked(): void {
    if (this.open() && !this.positioned() && !this.positionQueued) {
      // Defer past the current change-detection pass so setting the
      // position signals can't trip ExpressionChanged errors.
      this.positionQueued = true;
      queueMicrotask(() => {
        this.positionQueued = false;
        if (this.open() && !this.positioned()) {
          this.positionBubble();
        }
      });
    }
  }

  /** Tap/click on the ⓘ trigger toggles the pinned tooltip. */
  protected onTriggerClick(): void {
    if (this.pinned()) {
      this.hide();
    } else {
      this.show(true);
    }
  }

  /**
   * A pointer activation focuses the button too — swallow that focus so it
   * isn't mistaken for keyboard focus (which would open, then the click
   * would immediately toggle it shut again).
   */
  protected onTriggerPointerDown(): void {
    this.suppressFocusOpen = true;
  }

  /** Keyboard focus (Tab) opens the tooltip unpinned. */
  protected onTriggerFocusIn(): void {
    if (this.suppressFocusOpen) {
      this.suppressFocusOpen = false;
      return;
    }
    this.show(false);
  }

  /** Focus leaving the wrapper dismisses an unpinned tooltip. */
  protected onWrapperFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    if (next && this.host.nativeElement.contains(next)) {
      return;
    }
    if (!this.pinned()) {
      this.hide();
    }
  }

  /** Hover opens on hover-capable desktops only (touch uses tap). */
  protected onWrapperMouseEnter(): void {
    if (this.isHoverCapable()) {
      this.show(false);
    }
  }

  /** Leaving the wrapper dismisses an unpinned (hover/focus) tooltip. */
  protected onWrapperMouseLeave(): void {
    if (!this.pinned()) {
      this.hide();
    }
  }

  private show(pinned: boolean): void {
    this.pinned.set(pinned);
    if (!this.open()) {
      this.positioned.set(false);
      this.open.set(true);
    }
  }

  private hide(): void {
    this.open.set(false);
    this.pinned.set(false);
    this.positioned.set(false);
  }

  private reposition(): void {
    if (this.open()) {
      this.positionBubble();
    }
  }

  /**
   * Places the bubble above the trigger (flipped below when there is no
   * room), horizontally centered and clamped inside the viewport with an
   * 8px margin — so it stays on screen in a right-side ACTIONS column on
   * 390px mobile.
   */
  private positionBubble(): void {
    const bubble = this.bubbleRef()?.nativeElement;
    const trigger = this.triggerRef()?.nativeElement;
    if (!bubble || !trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const bubbleWidth = bubble.offsetWidth;
    const bubbleHeight = bubble.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const gap = 8;
    const margin = 8;

    let top = rect.top - bubbleHeight - gap;
    if (top < margin) {
      top = rect.bottom + gap;
    }
    top = Math.min(Math.max(margin, top), Math.max(margin, viewportHeight - bubbleHeight - margin));

    let left = rect.left + rect.width / 2 - bubbleWidth / 2;
    left = Math.min(Math.max(margin, left), Math.max(margin, viewportWidth - bubbleWidth - margin));

    this.position.set({ top, left });
    this.positioned.set(true);
  }

  private isHoverCapable(): boolean {
    if (this.hoverCapable === null) {
      this.hoverCapable =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    }
    return this.hoverCapable;
  }
}
