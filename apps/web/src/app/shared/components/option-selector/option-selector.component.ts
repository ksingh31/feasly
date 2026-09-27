import { Component, input, output } from '@angular/core';
import type { FinishTier } from '@feasly/contracts';

/**
 * Generic option-card shape. The `id` union must match the relevant contract
 * (FinishTier, GarageOption, BasementOption, …); the component stays
 * type-safe per use-site through the `TId` parameter.
 */
export interface OptionCard<TId extends string = string> {
  readonly id: TId;
  readonly name: string;
  readonly blurb: string;
}

/** Backwards-compatible alias for the finish-tier use-sites. */
export type TierOption = OptionCard<FinishTier>;

/**
 * Option selector (shared): radio-card group for any string-union choice.
 * Generalized from the finish-tier selector — used by the new-build scope
 * step (finish tier, garage, basement) and the neighbourhood comparison
 * picker (NBH-04). Built once, reused (DRY).
 *
 * Options arrive as inputs (config-owned at the call site); blurbs carry no
 * prices, ever.
 */
let nextControlId = 0;

@Component({
  selector: 'app-option-selector',
  standalone: true,
  templateUrl: './option-selector.component.html',
  styleUrl: './option-selector.component.scss',
})
export class OptionSelectorComponent<TId extends string = string> {
  /** Currently selected option id (null = none). */
  readonly selected = input.required<TId | null>();
  /** Options to render. */
  readonly options = input.required<readonly OptionCard<TId>[]>();
  /** Section heading. */
  readonly label = input.required<string>();
  /** Helper copy under the heading. */
  readonly hint = input<string>('');

  /** Emits the chosen option id. */
  readonly selectedChange = output<TId>();

  /** Stable id prefix for label association (unique per instance). */
  readonly controlId = `option-${++nextControlId}`;

  choose(id: TId): void {
    this.selectedChange.emit(id);
  }

  onKeydown(event: KeyboardEvent): void {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) {
      return;
    }
    event.preventDefault();
    const ids = this.options().map((o) => o.id);
    const current = ids.indexOf(this.selected() as TId);
    const next = (current + (forward ? 1 : -1) + ids.length) % ids.length;
    this.choose(ids[next]);
  }
}
