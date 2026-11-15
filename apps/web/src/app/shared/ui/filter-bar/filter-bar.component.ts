import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  afterNextRender,
  inject,
  type ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounce, map, timer } from 'rxjs';
import { UiSelectComponent, type UiSelectOption } from '../fields/select.component';
import { type TableFilters, activeFilterCount } from '../data-table/table-query';

/** One FilterBar select. The first three show inline; the rest sit behind "More filters". */
export interface FilterBarSelect {
  readonly key: string;
  readonly label: string;
  readonly options: readonly UiSelectOption[];
  /** Empty option label, e.g. "Any status". */
  readonly placeholder?: string;
}

export interface FilterChange {
  readonly key: string;
  readonly value: string | null;
}

/** Inline selects before "More filters" (§3: "≤3 inline selects"). */
const INLINE_SELECTS = 3;

let nextFilterBarId = 0;

/**
 * FilterBar (`ui-filter-bar`, portal-ui-kit §3).
 *
 * Controlled: `search` / `filters` come in (usually from `injectTableQuery`,
 * so they live in the URL) and changes go out as events.
 *
 * - Search emits `searchChange` after `debounceMs` of quiet (pass the
 *   ConfigService value; spec 250ms). `/` anywhere outside a text field
 *   focuses it.
 * - Up to three selects inline; the rest behind a "More filters" toggle.
 * - Active filters render as chips with ×; "Clear all" shows only while a
 *   search or filter is active.
 * - Below 768px: [Search] [Filters (n)], where Filters opens a bottom sheet
 *   with every select. Esc or Done closes it and focus returns to the button.
 */
@Component({
  selector: 'ui-filter-bar',
  standalone: true,
  imports: [UiSelectComponent],
  templateUrl: './filter-bar.component.html',
  styleUrl: './filter-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'ui-filter-bar',
    '(document:keydown)': 'onDocumentKeydown($event)',
  },
})
export class FilterBarComponent {
  readonly search = input('');
  readonly filters = input<TableFilters>({});
  readonly selects = input<readonly FilterBarSelect[]>([]);
  /** Search debounce in ms (ConfigService `timings.filterDebounceMs`). */
  readonly debounceMs = input.required<number>();

  readonly searchLabel = input('Search');
  readonly searchPlaceholder = input<string | null>(null);
  readonly moreFiltersLabel = input('More filters');
  readonly fewerFiltersLabel = input('Fewer filters');
  readonly filtersLabel = input('Filters');
  readonly clearAllLabel = input('Clear all');
  readonly removeFilterLabel = input('Remove filter');
  readonly doneLabel = input('Done');
  readonly activeFiltersLabel = input('Active filters');

  readonly searchChange = output<string>();
  readonly filterChange = output<FilterChange>();
  readonly clearAll = output<void>();

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private readonly sheetToggle = viewChild<ElementRef<HTMLButtonElement>>('sheetToggle');
  private readonly sheetTitle = viewChild<ElementRef<HTMLElement>>('sheetTitle');

  protected readonly uid = `ui-filter-bar-${nextFilterBarId++}`;
  /** What's in the search box right now (ahead of the debounced emit). */
  protected readonly draft = signal('');
  protected readonly moreOpen = signal(false);
  protected readonly sheetOpen = signal(false);

  protected readonly inline = computed(() => this.selects().slice(0, INLINE_SELECTS));
  protected readonly more = computed(() => this.selects().slice(INLINE_SELECTS));
  protected readonly activeCount = computed(() => activeFilterCount(this.filters()));
  protected readonly hasActive = computed(() => this.activeCount() > 0 || this.search().trim() !== '');

  protected readonly chips = computed(() =>
    this.selects().flatMap((select) => {
      const value = this.filters()[select.key];
      if (!value) return [];
      const option = select.options.find((o) => o.value === value);
      return [{ key: select.key, text: `${select.label}: ${option?.label ?? value}` }];
    }),
  );

  private readonly typed = new Subject<string>();
  private readonly injector = inject(Injector);

  constructor() {
    // Keep the box in step with the URL (back/forward, Clear all).
    effect(() => {
      const external = this.search();
      untracked(() => {
        if (external.trim() !== this.draft().trim()) this.draft.set(external);
      });
    });

    this.typed
      .pipe(
        debounce(() => timer(this.debounceMs())),
        map((value) => value.trim()),
        takeUntilDestroyed(),
      )
      .subscribe((value) => {
        if (value !== this.search().trim()) this.searchChange.emit(value);
      });
  }

  protected onType(value: string): void {
    this.draft.set(value);
    this.typed.next(value);
  }

  protected selectValue(key: string): string | null {
    return this.filters()[key] ?? null;
  }

  protected onSelect(key: string, value: string | null): void {
    if ((this.filters()[key] ?? null) !== value) this.filterChange.emit({ key, value });
  }

  protected removeChip(key: string): void {
    this.filterChange.emit({ key, value: null });
  }

  protected onClearAll(): void {
    this.draft.set('');
    this.typed.next('');
    this.clearAll.emit();
  }

  protected openSheet(): void {
    this.sheetOpen.set(true);
    afterNextRender(() => this.sheetTitle()?.nativeElement.focus(), { injector: this.injector });
  }

  protected closeSheet(): void {
    if (!this.sheetOpen()) return;
    this.sheetOpen.set(false);
    afterNextRender(() => this.sheetToggle()?.nativeElement.focus(), { injector: this.injector });
  }

  protected onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.sheetOpen()) {
      event.preventDefault();
      this.closeSheet();
      return;
    }
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTextEntry(event.target)) return;
    const input = this.searchInput()?.nativeElement;
    if (!input) return;
    event.preventDefault();
    input.focus();
  }
}

function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}
