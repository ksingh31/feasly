import { Component, input, output } from '@angular/core';
import type { FinishTier } from '@feasly/contracts';

/** Tier option shape (ids must match the FinishTier contract union). */
export interface TierOption {
  readonly id: FinishTier;
  readonly name: string;
  readonly blurb: string;
}

/**
 * Finish-tier selector (shared): radio-card group for the finish tier.
 * Used by the new-build scope step and the neighbourhood comparison picker
 * (NBH-04) — built once, reused (DRY).
 *
 * Options arrive as inputs (config-owned at the call site); blurbs carry no
 * prices, ever.
 */
let nextControlId = 0;

@Component({
  selector: 'app-tier-selector',
  standalone: true,
  templateUrl: './tier-selector.component.html',
  styleUrl: './tier-selector.component.scss',
})
export class TierSelectorComponent {
  /** Currently selected tier (null = none). */
  readonly selected = input.required<FinishTier | null>();
  /** Tier options to render. */
  readonly options = input.required<readonly TierOption[]>();
  /** Section heading. */
  readonly label = input.required<string>();
  /** Helper copy under the heading. */
  readonly hint = input<string>('');

  /** Emits the chosen tier id. */
  readonly selectedChange = output<FinishTier>();

  /** Stable id prefix for label association (unique per instance). */
  readonly controlId = `tier-${++nextControlId}`;

  choose(tier: FinishTier): void {
    this.selectedChange.emit(tier);
  }

  onKeydown(event: KeyboardEvent): void {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) {
      return;
    }
    event.preventDefault();
    const ids = this.options().map((o) => o.id);
    const current = ids.indexOf(this.selected() as FinishTier);
    const next = (current + (forward ? 1 : -1) + ids.length) % ids.length;
    this.choose(ids[next]);
  }
}
