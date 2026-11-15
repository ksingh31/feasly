import { ChangeDetectionStrategy, Component, computed, input, numberAttribute } from '@angular/core';

/**
 * Skeleton shapes:
 * - `text`  — paragraph lines (the last one shorter).
 * - `rows`  — table/list rows at the DataTable row height (48px).
 * - `block` — one card-sized placeholder.
 */
export type SkeletonVariant = 'text' | 'rows' | 'block';

/**
 * Skeleton (`ui-skeleton`) — a loading placeholder (portal UI kit §3).
 *
 * Exposes one polite `role="status"` with a screen-reader label; the bars
 * themselves are `aria-hidden`. The shimmer is plain CSS animation, which
 * the global reduced-motion kill-switch in styles.scss turns off.
 */
@Component({
  selector: 'ui-skeleton',
  standalone: true,
  templateUrl: './skeleton.component.html',
  styleUrl: './skeleton.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'ui-skeleton',
    role: 'status',
    'aria-live': 'polite',
  },
})
export class SkeletonComponent {
  readonly variant = input<SkeletonVariant>('text');
  /** Number of lines (`text`) or rows (`rows`). Ignored for `block`. */
  readonly count = input(3, { transform: numberAttribute });
  /** Screen-reader text announced while loading. */
  readonly label = input('Loading');

  protected readonly items = computed(() => {
    const n = this.variant() === 'block' ? 1 : Math.max(1, Math.floor(this.count() || 1));
    return Array.from({ length: n }, (_, i) => i);
  });
}
