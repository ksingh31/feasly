import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { StatusTone } from '../status/status-dictionary';

/**
 * KpiTile (portal-ui-kit §3): label, a 24px tabular value, an optional
 * sub-line and tone border. With `interactive` it renders as a button and
 * emits `activate` (click-through to the filtered list).
 *
 * `value` is display-ready text (format with the kit pipes); the tile does
 * no maths.
 */
@Component({
  selector: 'ui-kpi-tile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  templateUrl: './kpi-tile.component.html',
  styleUrl: './kpi-tile.component.scss',
})
export class KpiTileComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly sub = input<string | undefined>(undefined);
  /** Coloured left border; none when omitted. */
  readonly tone = input<StatusTone | undefined>(undefined);
  /** Render as a button that emits `activate`. */
  readonly interactive = input(false);

  readonly activate = output<void>();
}

/**
 * KPI grid: `repeat(auto-fit, minmax(200px, 1fr))`, so tiles reflow to one
 * column at 390px without widening the page.
 */
@Component({
  selector: 'ui-kpi-grid',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<ng-content />',
  styleUrl: './kpi-grid.component.scss',
})
export class KpiGridComponent {}
