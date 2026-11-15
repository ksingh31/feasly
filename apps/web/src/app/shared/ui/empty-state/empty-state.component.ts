import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * EmptyState variants (portal UI kit §3):
 * - `zero-data`  — nothing exists yet (optional "create" action).
 * - `no-results` — filters are active and match nothing. Only use this when
 *                  a filter is active; the usual action is "Clear filters".
 * - `all-clear`  — a queue the user has worked to zero.
 * - `error`      — the load failed; always offers Retry.
 * - `not-found`  — the record doesn't exist (404). Always "Back to {list}",
 *                  never "Try again": retrying a 404 can't succeed.
 */
export type EmptyStateVariant = 'zero-data' | 'no-results' | 'all-clear' | 'error' | 'not-found';

/** Router link target, as accepted by `routerLink`. */
export type UiLink = string | readonly unknown[];

/**
 * EmptyState (`ui-empty-state`) — icon, title, one line, optional action.
 *
 * Action rules by variant:
 * - `error`: a button labelled `actionLabel` (default "Retry") that emits
 *   `action`. The parent re-dispatches the load.
 * - `not-found`: a link "Back to {listLabel}" to `backLink`. There is no
 *   button and `action` never fires — a 404 must not offer a retry.
 * - other variants: optional. With `actionLink` it renders a link; with
 *   only `actionLabel` it renders a button that emits `action`.
 *
 * The error variant is `role="alert"` so the failure is announced; the
 * others are plain content.
 */
@Component({
  selector: 'ui-empty-state',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './empty-state.component.html',
  styleUrl: './empty-state.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'ui-empty-state',
    '[class]': "'ui-empty-state--' + variant()",
    '[attr.role]': "variant() === 'error' ? 'alert' : null",
  },
})
export class EmptyStateComponent {
  readonly variant = input.required<EmptyStateVariant>();
  readonly heading = input.required<string>();
  /** One supporting line. */
  readonly message = input<string | null>(null);

  /** Action label (zero-data/no-results/all-clear) or Retry label (error). */
  readonly actionLabel = input<string | null>(null);
  /** Turns the action into a link (zero-data/no-results/all-clear only). */
  readonly actionLink = input<UiLink | null>(null);
  /** Default label for the error variant's button. */
  readonly retryLabel = input('Retry');

  /** not-found: the list to go back to, e.g. "leads" → "Back to leads". */
  readonly listLabel = input<string | null>(null);
  /** not-found: the list route. */
  readonly backLink = input<UiLink | null>(null);
  /** not-found: the words before the list name. */
  readonly backPrefix = input('Back to');

  /** Fires on the action button (and on Retry for `error`). Never on not-found. */
  readonly action = output<void>();

  /** What the action slot renders, resolved from the variant rules above. */
  protected readonly actionKind = computed<'none' | 'button' | 'link' | 'back'>(() => {
    const variant = this.variant();
    if (variant === 'not-found') {
      return this.backLink() !== null && this.listLabel() ? 'back' : 'none';
    }
    if (variant === 'error') {
      return 'button';
    }
    if (!this.actionLabel()) {
      return 'none';
    }
    return this.actionLink() !== null ? 'link' : 'button';
  });

  protected readonly buttonLabel = computed(() =>
    this.variant() === 'error' ? (this.actionLabel() ?? this.retryLabel()) : (this.actionLabel() ?? ''),
  );

  protected onAction(): void {
    if (this.variant() !== 'not-found') {
      this.action.emit();
    }
  }
}
