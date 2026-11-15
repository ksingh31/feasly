import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  type TemplateRef,
  booleanAttribute,
  computed,
  contentChild,
  contentChildren,
  input,
  model,
  numberAttribute,
  output,
} from '@angular/core';
import { EmptyStateComponent } from '../empty-state/empty-state.component';
import { ErrorStateComponent } from '../error-state/error-state.component';
import { KitCountPipe, KitDatePipe, KitMoneyPipe } from '../format/format.pipes';
import { SkeletonComponent } from '../skeleton/skeleton.component';
import { StatusChipComponent } from '../status/status-chip.component';
import {
  type DataTableCellContext,
  type DataTableColumn,
  UiCellDirective,
  UiRowActionsDirective,
  cardLayout,
  columnAlign,
  columnValue,
  fromInteractive,
} from './data-table';
import { type TableSort, nextSort, pageCount, parseSort, serializeSort } from './table-query';

let nextTableId = 0;

/** Loading skeleton rows (§3: "loading skeleton (5 rows)"). */
const SKELETON_ROWS = 5;

/**
 * DataTable (`ui-data-table`, portal-ui-kit §3).
 *
 * Presentational and controlled: the page owns rows, sort and page (usually
 * via `injectTableQuery`, so they live in the URL) and re-loads on change.
 * The table never sorts or pages rows itself.
 *
 * - Sortable headers are buttons inside `<th aria-sort>`; click cycles
 *   asc → desc → none and emits `sortChange`.
 * - Row click or Enter emits `open` (clicks on buttons/links inside a row
 *   don't). `selectedId` gets the `--accent-bg` highlight.
 * - Optional selection (`selectable` + `[(selection)]`) with a bulk bar
 *   that projects `[uiBulkActions]` content while anything is selected.
 * - Slots: loading → 5-row skeleton, `error` → ErrorState with Retry,
 *   no rows → EmptyState (`zero-data`, or `no-results` when `filtered`).
 * - Pagination renders only when there is more than one page.
 * - Below 768px the table becomes a card list (title, chip, up to 3 meta
 *   lines, chevron) and a "Sort by" select replaces the headers. The host
 *   never grows wider than its container.
 */
@Component({
  selector: 'ui-data-table',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    EmptyStateComponent,
    ErrorStateComponent,
    SkeletonComponent,
    StatusChipComponent,
    KitMoneyPipe,
    KitCountPipe,
    KitDatePipe,
  ],
  templateUrl: './data-table.component.html',
  styleUrl: './data-table.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'ui-data-table',
    '[class.ui-data-table--compact]': 'compact()',
  },
})
export class DataTableComponent<T> {
  readonly rows = input.required<readonly T[]>();
  readonly columns = input.required<readonly DataTableColumn<T>[]>();
  /** Stable row id (track key, selection, `selectedId`). */
  readonly rowId = input.required<(row: T) => string>();
  /** Accessible name for the table / card list, e.g. "Leads". */
  readonly label = input.required<string>();

  readonly sort = input<TableSort | null>(null);
  readonly loading = input(false, { transform: booleanAttribute });
  /** Load failure message; renders the error slot instead of rows. */
  readonly error = input<string | null>(null);
  /** Filters are active → empty slot uses the `no-results` variant. */
  readonly filtered = input(false, { transform: booleanAttribute });
  /** Row whose drawer is open; highlighted. */
  readonly selectedId = input<string | null>(null);
  /**
   * Rows needing attention (e.g. stale leads) get the warning-tone
   * highlight. Visual only — pair it with text in a cell (a chip or label)
   * so the state isn't conveyed by colour alone.
   */
  readonly rowFlagged = input<((row: T) => boolean) | null>(null);
  /** 36px rows instead of 48px. */
  readonly compact = input(false, { transform: booleanAttribute });

  readonly selectable = input(false, { transform: booleanAttribute });
  readonly selection = model<readonly string[]>([]);

  /** 1-based current page. */
  readonly page = input(1, { transform: numberAttribute });
  /** Rows per page; with `total` decides whether pagination shows. */
  readonly pageSize = input(0, { transform: numberAttribute });
  /** Total rows across all pages (server count). Defaults to `rows.length`. */
  readonly total = input<number | null>(null);

  // Copy (defaults are kit fallbacks; pages pass ConfigService copy).
  readonly emptyHeading = input('Nothing here yet');
  readonly emptyMessage = input<string | null>(null);
  readonly noResultsHeading = input('No matches');
  readonly noResultsMessage = input<string | null>('Try a different search or clear the filters.');
  readonly clearFiltersLabel = input('Clear filters');
  readonly errorHeading = input('Couldn’t load this list');
  readonly retryLabel = input('Retry');
  readonly loadingLabel = input('Loading');
  readonly selectAllLabel = input('Select all rows on this page');
  readonly selectRowLabel = input('Select');
  readonly selectedCountLabel = input('selected');
  readonly actionsHeader = input('Actions');
  readonly sortByLabel = input('Sort by');
  readonly noSortLabel = input('Default order');
  readonly ascendingLabel = input('ascending');
  readonly descendingLabel = input('descending');
  readonly previousLabel = input('Previous');
  readonly nextLabel = input('Next');
  readonly pageLabel = input('Page');
  readonly pageOfLabel = input('of');
  readonly paginationLabel = input('Pagination');

  readonly sortChange = output<TableSort | null>();
  readonly open = output<T>();
  readonly pageChange = output<number>();
  readonly retry = output<void>();
  /** Empty `no-results` state's "Clear filters" action. */
  readonly clearFilters = output<void>();

  private readonly cellTemplates = contentChildren(UiCellDirective);
  private readonly rowActions = contentChild(UiRowActionsDirective);

  protected readonly uid = `ui-data-table-${nextTableId++}`;
  protected readonly skeletonRows = SKELETON_ROWS;

  protected readonly templates = computed(() => {
    const map = new Map<string, TemplateRef<DataTableCellContext<T>>>();
    for (const t of this.cellTemplates()) {
      map.set(t.uiCell(), t.template as TemplateRef<DataTableCellContext<T>>);
    }
    return map;
  });
  protected readonly actionsTemplate = computed(
    () => this.rowActions()?.template as TemplateRef<DataTableCellContext<T>> | undefined,
  );

  protected readonly card = computed(() => cardLayout(this.columns()));

  protected readonly state = computed<'loading' | 'error' | 'empty' | 'rows'>(() => {
    if (this.loading()) return 'loading';
    if (this.error()) return 'error';
    return this.rows().length === 0 ? 'empty' : 'rows';
  });

  protected readonly pages = computed(() =>
    pageCount(this.total() ?? this.rows().length, this.pageSize()),
  );
  protected readonly showPagination = computed(() => this.state() === 'rows' && this.pages() > 1);

  protected readonly sortOptions = computed(() =>
    this.columns()
      .filter((c) => c.sortable)
      .flatMap((c) => [
        { value: c.key, label: `${c.header}, ${this.ascendingLabel()}` },
        { value: `-${c.key}`, label: `${c.header}, ${this.descendingLabel()}` },
      ]),
  );
  protected readonly sortValue = computed(() => serializeSort(this.sort()) ?? '');

  private readonly selectedSet = computed(() => new Set(this.selection()));
  protected readonly pageIds = computed(() => this.rows().map((r) => this.rowId()(r)));
  protected readonly allSelected = computed(
    () => this.pageIds().length > 0 && this.pageIds().every((id) => this.selectedSet().has(id)),
  );
  protected readonly someSelected = computed(
    () => !this.allSelected() && this.pageIds().some((id) => this.selectedSet().has(id)),
  );

  protected value(column: DataTableColumn<T>, row: T): unknown {
    return columnValue(column, row);
  }

  protected align(column: DataTableColumn<T>): 'start' | 'end' {
    return columnAlign(column);
  }

  protected text(column: DataTableColumn<T>, row: T): string {
    const v = columnValue(column, row);
    return v === null || v === undefined || v === '' ? '—' : String(v);
  }

  protected asNumber(v: unknown): number | null {
    return typeof v === 'number' ? v : null;
  }

  protected asString(v: unknown): string | null {
    return typeof v === 'string' ? v : null;
  }

  protected ctx(row: T, column?: DataTableColumn<T>): DataTableCellContext<T> {
    return { $implicit: row, value: column ? columnValue(column, row) : undefined };
  }

  protected ariaSort(column: DataTableColumn<T>): 'ascending' | 'descending' | 'none' | null {
    if (!column.sortable) return null;
    const sort = this.sort();
    if (sort?.key !== column.key) return 'none';
    return sort.direction === 'asc' ? 'ascending' : 'descending';
  }

  protected onSort(column: DataTableColumn<T>): void {
    this.sortChange.emit(nextSort(this.sort(), column.key));
  }

  protected onSortSelect(raw: string): void {
    this.sortChange.emit(parseSort(raw, this.columns().filter((c) => c.sortable).map((c) => c.key)));
  }

  protected onRowClick(event: Event, row: T): void {
    if (fromInteractive(event, event.currentTarget as Element)) return;
    this.open.emit(row);
  }

  protected onRowKeydown(event: KeyboardEvent, row: T): void {
    if (event.key !== 'Enter' || event.target !== event.currentTarget) return;
    event.preventDefault();
    this.open.emit(row);
  }

  protected isSelected(row: T): boolean {
    return this.selectedSet().has(this.rowId()(row));
  }

  protected isFlagged(row: T): boolean {
    return this.rowFlagged()?.(row) ?? false;
  }

  protected isOpen(row: T): boolean {
    const id = this.selectedId();
    return id !== null && this.rowId()(row) === id;
  }

  protected toggleRow(row: T, checked: boolean): void {
    const id = this.rowId()(row);
    const next = new Set(this.selection());
    if (checked) next.add(id);
    else next.delete(id);
    this.selection.set([...next]);
  }

  protected toggleAll(checked: boolean): void {
    const next = new Set(this.selection());
    for (const id of this.pageIds()) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    this.selection.set([...next]);
  }

  protected goTo(page: number): void {
    if (page >= 1 && page <= this.pages() && page !== this.page()) this.pageChange.emit(page);
  }
}
