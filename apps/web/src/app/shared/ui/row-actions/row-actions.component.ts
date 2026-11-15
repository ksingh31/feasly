import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output } from '@angular/core';

/** One entry in a {@link UiRowActionsComponent} kebab menu. */
export interface UiRowAction {
  /** Stable key emitted by `selected`. */
  readonly id: string;
  /** Visible label, sentence case: "Resend invite". */
  readonly label: string;
  /** `danger` renders the item in the danger colour (destructive actions). */
  readonly tone?: 'default' | 'danger';
  /** Shown but not selectable (e.g. a guard the backend would refuse). */
  readonly disabled?: boolean;
  /** Short explainer under the label — announced via `aria-describedby`. */
  readonly hint?: string;
}

let nextRowActionsId = 0;

/**
 * RowActions — portal-ui-kit §3 DataTable "row actions: one inline button
 * plus a kebab". A ⋮ trigger that opens a CDK menu (arrow keys, Home/End,
 * type-ahead, Esc returns focus to the trigger) rendered in an overlay so
 * it never widens or clips inside a scrolling table.
 *
 *   <ui-row-actions
 *     [actions]="[{ id: 'edit', label: 'Edit' }, { id: 'delete', label: 'Delete', tone: 'danger' }]"
 *     label="Actions for Marco Silva"
 *     (selected)="onAction(row, $event)" />
 *
 * `selected` fires after the menu closes (a microtask later), with focus
 * back on the trigger.
 *
 * Renders nothing when `actions` is empty, so callers can pass a filtered
 * list without wrapping it in `@if`. Destructive items must still confirm
 * through `UiConfirmService` — this menu only reports the choice.
 */
@Component({
  selector: 'ui-row-actions',
  standalone: true,
  imports: [CdkMenuTrigger, CdkMenu, CdkMenuItem],
  templateUrl: './row-actions.component.html',
  styleUrl: './row-actions.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiRowActionsComponent {
  readonly actions = input.required<readonly UiRowAction[]>();
  /** Accessible name for the trigger — name the row: "Actions for Marco Silva". */
  readonly label = input('Row actions');
  /** Disable the whole trigger (e.g. while a row mutation is in flight). */
  readonly disabled = input(false);

  /** The id of the chosen action. */
  readonly selected = output<string>();

  protected readonly baseId = `ui-row-actions-${nextRowActionsId++}`;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
  }

  protected hintId(action: UiRowAction): string | null {
    return action.hint ? `${this.baseId}-${action.id}-hint` : null;
  }

  /**
   * Emits once the menu has closed and focus is back on the ⋮ trigger (the
   * CDK closes the menu right after `cdkMenuItemTriggered`). A dialog the
   * caller opens in response then restores focus to the trigger, not to a
   * menu item that no longer exists.
   */
  protected choose(action: UiRowAction): void {
    if (action.disabled) return;
    void Promise.resolve().then(() => {
      if (!this.destroyed) this.selected.emit(action.id);
    });
  }
}
