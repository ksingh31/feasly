import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** One label/value row. */
export interface KeyValueItem {
  readonly label: string;
  /** Already-formatted display value; null/empty renders `emptyValue`. */
  readonly value: string | number | null | undefined;
  /**
   * Optional href — phone and email are always `tel:` / `mailto:` links
   * (portal UI kit §5). Internal routes belong in an EntityLink instead.
   */
  readonly href?: string;
}

/**
 * KeyValueList (`ui-key-value-list`) — a two-column label/value grid that
 * collapses to stacked label-over-value when its container is narrow
 * (portal UI kit §3). Replaces label/value rows pushed to opposite edges.
 *
 * Uses a container query, so it collapses inside a 400px drawer as well as
 * on a 390px phone. Values wrap anywhere (long emails, IDs) so the list
 * never widens the page.
 */
@Component({
  selector: 'ui-key-value-list',
  standalone: true,
  templateUrl: './key-value-list.component.html',
  styleUrl: './key-value-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ui-key-value-list' },
})
export class KeyValueListComponent {
  readonly items = input.required<readonly KeyValueItem[]>();
  /** Shown for a missing value so a row never looks broken. */
  readonly emptyValue = input('—');

  protected isEmpty(value: KeyValueItem['value']): boolean {
    return value === null || value === undefined || value === '';
  }
}
