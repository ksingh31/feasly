import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { EmptyStateComponent, type UiLink } from '../empty-state/empty-state.component';

/** ErrorState kinds: a failed load (retryable) or a missing record (404). */
export type ErrorStateKind = 'error' | 'not-found';

/**
 * ErrorState (`ui-error-state`) — the failure face of EmptyState, so pages
 * don't have to remember the 404 rule (portal UI kit §3):
 *
 * - `kind="error"` (default): Retry button → `retry` output.
 * - `kind="not-found"`: "Back to {listLabel}" link to `backLink`. No Retry,
 *   ever — `retry` never fires for a 404.
 *
 * ```html
 * <ui-error-state kind="not-found" heading="Lead not found"
 *   listLabel="leads" [backLink]="['/builder/leads']" />
 * ```
 */
@Component({
  selector: 'ui-error-state',
  standalone: true,
  imports: [EmptyStateComponent],
  templateUrl: './error-state.component.html',
  styles: ':host { display: block; min-width: 0; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ui-error-state' },
})
export class ErrorStateComponent {
  readonly kind = input<ErrorStateKind>('error');
  readonly heading = input.required<string>();
  readonly message = input<string | null>(null);
  readonly retryLabel = input('Retry');
  /** not-found: the list to go back to, e.g. "invoices". */
  readonly listLabel = input<string | null>(null);
  /** not-found: the list route. */
  readonly backLink = input<UiLink | null>(null);

  /** Retry pressed (error kind only). */
  readonly retry = output<void>();
}
