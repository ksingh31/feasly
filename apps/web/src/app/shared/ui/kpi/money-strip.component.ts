import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { type MoneyStripItem, moneyStripTone, tierMoneyStripItems } from './money-strip';

/**
 * MoneyStrip (portal-ui-kit §3): one severity-tiered line
 * ("1 card failed · $19,800 charges tonight") with at most one CTA. The
 * most severe item leads and sets the strip's tone. Renders nothing when
 * there are no items.
 */
@Component({
  selector: 'ui-money-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './money-strip.component.html',
  styleUrl: './money-strip.component.scss',
})
export class MoneyStripComponent {
  readonly items = input.required<readonly MoneyStripItem[]>();
  /** The single call to action; omitted → no button. */
  readonly ctaLabel = input<string | undefined>(undefined);
  /** Accessible name for the region. */
  readonly label = input('Money summary');

  readonly cta = output<void>();

  protected readonly tiered = computed(() => tierMoneyStripItems(this.items()));
  protected readonly tone = computed(() => moneyStripTone(this.items()));
}
