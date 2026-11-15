import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { type StatusDomain, statusPresentation } from './status-dictionary';

/**
 * StatusChip (portal-ui-kit §3): a 22px pill whose tone and sentence-case
 * label come from the status dictionary. `label` overrides the dictionary
 * text when a surface needs detail (e.g. "Auto-charges in 3 days") while
 * keeping the status's tone.
 */
@Component({
  selector: 'ui-status-chip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './status-chip.component.html',
  styleUrl: './status-chip.component.scss',
})
export class StatusChipComponent {
  readonly domain = input.required<StatusDomain>();
  readonly status = input.required<string | null | undefined>();
  readonly dot = input(false);
  readonly label = input<string | undefined>(undefined);

  protected readonly presentation = computed(() =>
    statusPresentation(this.domain(), this.status()),
  );

  /** Visible text; also the `title` so a truncated label can be read in full. */
  protected readonly text = computed(() => this.label() ?? this.presentation().label);
}
