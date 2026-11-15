import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  booleanAttribute,
  computed,
  inject,
  input,
} from '@angular/core';

export type UiButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-secondary';
export type UiButtonSize = 'sm' | 'md';

/**
 * Button — portal UI kit §3 (docs/design/portal-ui-kit.md).
 *
 * An attribute component on the native element, so semantics, form submit
 * and keyboard activation stay native:
 *
 *   <button type="button" ui-button variant="secondary" size="sm">Export</button>
 *   <button type="submit" ui-button [loading]="saving()">Save</button>
 *   <a ui-button variant="ghost" routerLink="/leads">Back to leads</a>
 *
 * - Variants: primary · secondary · ghost · danger · danger-secondary.
 * - Sizes: sm (32px) · md (40px); the tap area is ≥44px on phones/touch.
 * - `disabled` → 40% opacity + not-allowed. Enabled never looks disabled.
 * - `loading` → spinner over the (hidden) label, so the width never changes;
 *   the button is inert (native disabled / aria-disabled) and `aria-busy`.
 * - Focus ring `0 0 0 3px var(--focus-ring)` on `:focus-visible`.
 */
@Component({
  selector: 'button[ui-button], a[ui-button]',
  standalone: true,
  templateUrl: './button.component.html',
  styleUrl: './button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClasses()',
    '[attr.disabled]': 'isNativeButton && inert() ? "" : null',
    '[attr.aria-disabled]': '!isNativeButton && inert() ? "true" : null',
    '[attr.tabindex]': '!isNativeButton && inert() ? "-1" : null',
    '[attr.aria-busy]': 'loading() ? "true" : null',
  },
})
export class UiButtonComponent {
  readonly variant = input<UiButtonVariant>('primary');
  readonly size = input<UiButtonSize>('md');
  readonly loading = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly isNativeButton = this.el.tagName === 'BUTTON';

  /** Not interactive: disabled or busy. */
  protected readonly inert = computed(() => this.disabled() || this.loading());

  protected readonly hostClasses = computed(() =>
    [
      'ui-button',
      `ui-button--${this.variant()}`,
      `ui-button--${this.size()}`,
      this.loading() ? 'ui-button--loading' : '',
      this.disabled() ? 'ui-button--disabled' : '',
    ]
      .filter(Boolean)
      .join(' '),
  );

  constructor() {
    // Anchors have no native disabled state: swallow activation while inert.
    // A capture listener on the element runs before the consumer's (click)
    // binding (host listeners would run after template listeners).
    const swallow = (event: Event): void => {
      if (this.inert()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    this.el.addEventListener('click', swallow, { capture: true });
    inject(DestroyRef).onDestroy(() =>
      this.el.removeEventListener('click', swallow, { capture: true }),
    );
  }
}
