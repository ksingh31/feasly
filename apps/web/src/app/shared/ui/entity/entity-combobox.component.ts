import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  input,
  output,
  signal,
} from '@angular/core';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { type EntityOption, filterEntityOptions } from './entity-option';

let nextComboboxId = 0;

/**
 * EntityCombobox (portal-ui-kit §3): a type-ahead that replaces every
 * "paste a UUID" field. The user searches by human label; the form value
 * is the selected record's id (or null).
 *
 * WAI-ARIA combobox (list autocomplete): ↑/↓ move the active option (and
 * open the list), Enter picks it, Esc closes the list and restores the
 * selected label. Works as a reactive-forms control (`formControlName`).
 *
 * Options come from the host. By default they are filtered locally; set
 * `filterLocally=false` and listen to `queryChange` to search on the server.
 */
@Component({
  selector: 'ui-entity-combobox',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './entity-combobox.component.html',
  styleUrl: './entity-combobox.component.scss',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => EntityComboboxComponent),
      multi: true,
    },
  ],
})
export class EntityComboboxComponent implements ControlValueAccessor {
  /** Visible label above the field. */
  readonly label = input.required<string>();
  readonly options = input.required<readonly EntityOption[]>();
  readonly placeholder = input('');
  readonly hint = input<string | undefined>(undefined);
  readonly error = input<string | undefined>(undefined);
  readonly emptyLabel = input('No matches');
  readonly loading = input(false);
  readonly loadingLabel = input('Searching…');
  readonly filterLocally = input(true);

  /** The text the user typed (debounce on the host if it hits the server). */
  readonly queryChange = output<string>();
  /** The option the user picked, or null when they cleared the field. */
  readonly selectionChange = output<EntityOption | null>();

  protected readonly uid = `ui-entity-combobox-${nextComboboxId++}`;
  protected readonly inputId = `${this.uid}-input`;
  protected readonly listId = `${this.uid}-list`;
  protected readonly hintId = `${this.uid}-hint`;
  protected readonly errorId = `${this.uid}-error`;

  protected readonly open = signal(false);
  protected readonly activeIndex = signal(-1);
  protected readonly disabled = signal(false);
  private readonly value = signal<string | null>(null);
  /** Last picked option, so the label survives the host swapping `options`. */
  private readonly picked = signal<EntityOption | null>(null);
  private readonly query = signal('');
  private readonly editing = signal(false);

  private onChange: (value: string | null) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  protected readonly selectedLabel = computed(() => {
    const id = this.value();
    if (id === null) {
      return '';
    }
    const fromOptions = this.options().find((o) => o.id === id);
    if (fromOptions) {
      return fromOptions.label;
    }
    const picked = this.picked();
    return picked?.id === id ? picked.label : '';
  });

  protected readonly inputText = computed(() =>
    this.editing() ? this.query() : this.selectedLabel(),
  );

  /**
   * Options the user can see and pick. Empty while `loading()`: the list only
   * renders the loading row then, so Enter / aria-activedescendant must not
   * reach a stale (hidden) option from the previous search.
   */
  protected readonly shown = computed(() => {
    if (this.loading()) {
      return [];
    }
    return this.filterLocally() && this.editing()
      ? filterEntityOptions(this.options(), this.query())
      : [...this.options()];
  });

  protected readonly activeId = computed(() => {
    const index = this.activeIndex();
    return this.open() && index >= 0 && index < this.shown().length
      ? this.optionId(index)
      : null;
  });

  protected readonly describedBy = computed(() => {
    const ids = [this.hint() ? this.hintId : '', this.error() ? this.errorId : ''];
    return ids.filter(Boolean).join(' ') || null;
  });

  protected optionId(index: number): string {
    return `${this.uid}-option-${index}`;
  }

  protected isSelected(option: EntityOption): boolean {
    return option.id === this.value();
  }

  // ---- ControlValueAccessor -------------------------------------------

  writeValue(value: string | null | undefined): void {
    this.value.set(value ?? null);
    this.editing.set(false);
  }

  registerOnChange(fn: (value: string | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(disabled: boolean): void {
    this.disabled.set(disabled);
    if (disabled) {
      this.close();
    }
  }

  // ---- Interaction ----------------------------------------------------

  protected onInput(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.editing.set(true);
    this.query.set(text);
    this.open.set(true);
    this.activeIndex.set(this.shown().length > 0 ? 0 : -1);
    this.queryChange.emit(text);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.shown().length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveActive(1, count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveActive(-1, count);
        break;
      case 'Enter': {
        const option = this.open() ? this.shown()[this.activeIndex()] : undefined;
        if (option) {
          event.preventDefault();
          this.select(option);
        }
        break;
      }
      case 'Escape':
        if (this.open() || this.editing()) {
          event.preventDefault();
          event.stopPropagation(); // don't also close the drawer/modal we sit in
          this.close();
        }
        break;
      default:
        break;
    }
  }

  protected onBlur(): void {
    // Typing the field empty and leaving it clears the value.
    if (this.editing() && this.query().trim() === '' && this.value() !== null) {
      this.commit(null);
    }
    this.close();
    this.onTouched();
  }

  protected toggleList(): void {
    if (this.disabled()) {
      return;
    }
    if (this.open()) {
      this.close();
    } else {
      this.openList();
    }
  }

  /** mousedown (not click) so the input keeps focus and blur doesn't close the list first. */
  protected onOptionPointerDown(event: Event, option: EntityOption): void {
    event.preventDefault();
    this.select(option);
  }

  protected select(option: EntityOption): void {
    this.picked.set(option);
    this.commit(option);
    this.close();
  }

  private commit(option: EntityOption | null): void {
    const id = option?.id ?? null;
    const changed = id !== this.value();
    this.value.set(id);
    if (changed) {
      this.onChange(id);
      this.selectionChange.emit(option);
    }
  }

  private openList(): void {
    this.open.set(true);
    const selected = this.shown().findIndex((o) => o.id === this.value());
    this.activeIndex.set(selected >= 0 ? selected : this.shown().length > 0 ? 0 : -1);
  }

  private moveActive(step: 1 | -1, count: number): void {
    if (!this.open()) {
      this.openList();
      return;
    }
    if (count === 0) {
      this.activeIndex.set(-1);
      return;
    }
    const current = this.activeIndex();
    const start = current < 0 ? (step === 1 ? -1 : 0) : current;
    this.activeIndex.set((start + step + count) % count);
  }

  private close(): void {
    this.open.set(false);
    this.activeIndex.set(-1);
    this.editing.set(false);
    this.query.set('');
  }
}
