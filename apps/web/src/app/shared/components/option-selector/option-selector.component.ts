import { Component, input, output } from '@angular/core';
import type { FinishTier } from '@feasly/contracts';
import { handleRadioGroupKeydown, radioTabIndex } from '../../../core/utils/radio-group';

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
  /**
   * Flat variant (#508): no own card box and a single-column list, with an
   * h3 heading — for use INSIDE another card (never a card in a card).
   */
  readonly flat = input<boolean>(false);

  /** Emits the chosen option id. */
  readonly selectedChange = output<TId>();

  /** Stable id prefix for label association (unique per instance). */
  readonly controlId = `option-${++nextControlId}`;

  choose(id: TId): void {
    this.selectedChange.emit(id);
  }

  /** Roving tabindex (#937): the checked card (or the first) is the group's one Tab stop. */
  tabIndexFor(id: TId): 0 | -1 {
    return radioTabIndex(this.ids(), this.selected(), id);
  }

  /** Radio-group keys: arrows/Home/End move focus and selection within the group. */
  onKeydown(event: KeyboardEvent): void {
    handleRadioGroupKeydown(event, this.ids(), this.selected(), (id) => this.choose(id));
  }

  private ids(): TId[] {
    return this.options().map((o) => o.id);
  }
}
