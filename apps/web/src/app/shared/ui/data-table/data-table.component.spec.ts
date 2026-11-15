import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { type DataTableColumn, UiCellDirective, UiRowActionsDirective, cardLayout } from './data-table';
import { DataTableComponent } from './data-table.component';
import type { TableSort } from './table-query';

interface Lead {
  id: string;
  name: string;
  status: string;
  amount: number;
  ref: string;
}

const ROWS: Lead[] = [
  { id: 'l1', name: 'Marco Silva', status: 'won', amount: 1980000, ref: 'INV-0001' },
  { id: 'l2', name: 'Priya Shah', status: 'new', amount: 250000, ref: 'INV-0002' },
];

const COLUMNS: DataTableColumn<Lead>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'status', header: 'Status', kind: 'status', statusDomain: 'lead' },
  { key: 'amount', header: 'Amount', kind: 'money', sortable: true },
  { key: 'ref', header: 'Invoice', kind: 'id' },
];

@Component({
  standalone: true,
  imports: [DataTableComponent, UiCellDirective, UiRowActionsDirective],
  template: `
    <ui-data-table
      label="Leads"
      [rows]="rows()"
      [columns]="columns"
      [rowId]="rowId"
      [sort]="sort()"
      [loading]="loading()"
      [error]="error()"
      [filtered]="filtered()"
      [selectedId]="selectedId()"
      [selectable]="selectable()"
      [(selection)]="selection"
      [page]="page()"
      [pageSize]="pageSize()"
      [total]="total()"
      (sortChange)="sorts.push($event)"
      (open)="opened.push($event.id)"
      (pageChange)="pages.push($event)"
      (retry)="retries = retries + 1"
      (clearFilters)="clears = clears + 1"
    >
      <button uiBulkActions type="button" class="bulk-btn">Archive</button>
      <ng-template uiCell="ref" let-row>
        <a class="ref-link" href="#">{{ row.ref }}</a>
      </ng-template>
      <ng-template uiRowActions let-row>
        <button type="button" class="row-action">Email {{ row.name }}</button>
      </ng-template>
    </ui-data-table>
  `,
})
class HostComponent {
  readonly rows = signal<readonly Lead[]>(ROWS);
  readonly columns = COLUMNS;
  readonly rowId = (row: Lead): string => row.id;
  readonly sort = signal<TableSort | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly filtered = signal(false);
  readonly selectedId = signal<string | null>(null);
  readonly selectable = signal(false);
  readonly selection = signal<readonly string[]>([]);
  readonly page = signal(1);
  readonly pageSize = signal(25);
  readonly total = signal<number | null>(null);
  readonly sorts: (TableSort | null)[] = [];
  readonly opened: string[] = [];
  readonly pages: number[] = [];
  retries = 0;
  clears = 0;
}

describe('DataTableComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  function setup(): HTMLElement {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent], providers: [provideRouter([])] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function render(): HTMLElement {
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const rows = (el: HTMLElement): HTMLTableRowElement[] => Array.from(el.querySelectorAll('tbody tr'));
  const headers = (el: HTMLElement): HTMLTableCellElement[] => Array.from(el.querySelectorAll('thead th'));

  it('renders columns, kinds and custom cell templates', () => {
    const el = setup();
    expect(headers(el).map((th) => th.textContent?.trim())).toEqual(['Name', 'Status', 'Amount', 'Invoice', 'Actions']);
    const cells = rows(el)[0].querySelectorAll('td');
    expect(cells[0].textContent?.trim()).toBe('Marco Silva');
    expect(cells[0].querySelector('.ui-dt__clamp')?.getAttribute('title')).toBe('Marco Silva');
    expect(cells[1].querySelector('ui-status-chip')).not.toBeNull();
    expect(cells[2].textContent?.trim()).toBe('$19,800');
    expect(cells[2].classList).toContain('ui-dt__end');
    expect(cells[3].querySelector('a.ref-link')?.textContent).toBe('INV-0001');
  });

  it('sortable headers expose aria-sort and emit the next sort on click', () => {
    const el = setup();
    const [name, status, amount] = headers(el);
    expect(name.getAttribute('aria-sort')).toBe('none');
    expect(status.hasAttribute('aria-sort')).toBe(false);
    expect(status.querySelector('button')).toBeNull();

    host.sort.set({ key: 'amount', direction: 'desc' });
    render();
    expect(amount.getAttribute('aria-sort')).toBe('descending');

    (name.querySelector('button') as HTMLButtonElement).click();
    (amount.querySelector('button') as HTMLButtonElement).click();
    expect(host.sorts).toEqual([{ key: 'name', direction: 'asc' }, null]);
  });

  it('row click or Enter emits open; clicks on controls inside do not', () => {
    const el = setup();
    const [first, second] = rows(el);
    first.click();
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    second.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    (first.querySelector('.row-action') as HTMLButtonElement).click();
    (first.querySelector('.ref-link') as HTMLAnchorElement).click();
    expect(host.opened).toEqual(['l1', 'l2']);
    expect(first.getAttribute('tabindex')).toBe('0');
  });

  it('Enter on a control inside the row does not open it', () => {
    const el = setup();
    rows(el)[0]
      .querySelector('.row-action')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(host.opened).toEqual([]);
  });

  it('highlights the open row', () => {
    const el = setup();
    host.selectedId.set('l2');
    render();
    expect(rows(el)[1].classList).toContain('ui-dt__row--open');
    expect(rows(el)[1].getAttribute('aria-current')).toBe('true');
    expect(rows(el)[0].classList).not.toContain('ui-dt__row--open');
  });

  it('selection: row and select-all checkboxes drive the model and bulk bar', () => {
    const el = setup();
    expect(el.querySelector('input[type=checkbox]')).toBeNull();
    host.selectable.set(true);
    render();
    expect(el.querySelector('.ui-dt__bulk')).toBeNull();

    const rowBox = rows(el)[0].querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(rowBox.getAttribute('aria-label')).toBe('Select Marco Silva');
    rowBox.click();
    render();
    expect(host.selection()).toEqual(['l1']);
    expect(host.opened).toEqual([]);
    const all = el.querySelector('thead input[type=checkbox]') as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    expect(el.querySelector('.ui-dt__bulk')?.textContent).toContain('1 selected');
    expect(el.querySelector('.ui-dt__bulk .bulk-btn')).not.toBeNull();

    all.click();
    render();
    expect([...host.selection()].sort()).toEqual(['l1', 'l2']);
    expect(all.checked).toBe(true);
    all.click();
    render();
    expect(host.selection()).toEqual([]);
  });

  it('loading shows a 5-row skeleton', () => {
    const el = setup();
    host.loading.set(true);
    render();
    expect(el.querySelector('table')).toBeNull();
    expect(el.querySelectorAll('ui-skeleton .ui-skeleton__bar').length).toBe(5);
  });

  it('error shows ErrorState with Retry', () => {
    const el = setup();
    host.error.set('Network down');
    render();
    expect(el.querySelector('table')).toBeNull();
    expect(el.textContent).toContain('Network down');
    (el.querySelector('ui-error-state button') as HTMLButtonElement).click();
    expect(host.retries).toBe(1);
  });

  it('empty: zero-data without filters, no-results (with Clear filters) when filtered', () => {
    const el = setup();
    host.rows.set([]);
    render();
    expect(el.querySelector('.ui-empty-state--zero-data')).not.toBeNull();
    host.filtered.set(true);
    render();
    expect(el.querySelector('.ui-empty-state--no-results')).not.toBeNull();
    (el.querySelector('ui-empty-state button') as HTMLButtonElement).click();
    expect(host.clears).toBe(1);
    expect(el.querySelector('.ui-dt__pager')).toBeNull();
  });

  it('pagination only when there is more than one page', () => {
    const el = setup();
    expect(el.querySelector('.ui-dt__pager')).toBeNull();
    host.total.set(25);
    render();
    expect(el.querySelector('.ui-dt__pager')).toBeNull();

    host.total.set(60);
    host.page.set(2);
    render();
    const pager = el.querySelector('.ui-dt__pager') as HTMLElement;
    expect(pager.textContent).toContain('Page 2 of 3');
    const [prev, next] = Array.from(pager.querySelectorAll('button'));
    prev.click();
    next.click();
    expect(host.pages).toEqual([1, 3]);

    host.page.set(3);
    render();
    expect((pager.querySelectorAll('button')[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the mobile card list with title, chip, meta and chevron', () => {
    const el = setup();
    const cards = Array.from(el.querySelectorAll('.ui-dt__card')) as HTMLElement[];
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.ui-dt__card-title')?.textContent?.trim()).toBe('Marco Silva');
    expect(cards[0].querySelector('.ui-dt__card-head ui-status-chip')).not.toBeNull();
    const meta = Array.from(cards[0].querySelectorAll('.ui-dt__card-meta')).map((m) =>
      Array.from(m.children).map((c) => c.textContent?.trim()),
    );
    expect(meta).toEqual([
      ['Amount:', '$19,800'],
      ['Invoice:', 'INV-0001'],
    ]);
    expect(cards[0].querySelector('.ui-dt__chevron')).not.toBeNull();

    cards[1].click();
    cards[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(host.opened).toEqual(['l2', 'l1']);
  });

  it('mobile sort select emits the chosen sort', () => {
    const el = setup();
    const select = el.querySelector('.ui-dt__sort-select select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'name', '-name', 'amount', '-amount']);
    select.value = '-amount';
    select.dispatchEvent(new Event('change'));
    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(host.sorts).toEqual([{ key: 'amount', direction: 'desc' }, null]);
  });
});

describe('cardLayout', () => {
  it('defaults: first column title, first status chip, next three meta', () => {
    const cols: DataTableColumn<unknown>[] = [
      { key: 'a', header: 'A' },
      { key: 'b', header: 'B', kind: 'status', statusDomain: 'lead' },
      { key: 'c', header: 'C' },
      { key: 'd', header: 'D' },
      { key: 'e', header: 'E' },
      { key: 'f', header: 'F' },
    ];
    const layout = cardLayout(cols);
    expect(layout.title?.key).toBe('a');
    expect(layout.chip?.key).toBe('b');
    expect(layout.meta.map((c) => c.key)).toEqual(['c', 'd', 'e']);
  });

  it('honours explicit roles', () => {
    const cols: DataTableColumn<unknown>[] = [
      { key: 'a', header: 'A', cardRole: 'hidden' },
      { key: 'b', header: 'B', cardRole: 'title' },
      { key: 'c', header: 'C', cardRole: 'meta' },
      { key: 'd', header: 'D' },
    ];
    const layout = cardLayout(cols);
    expect(layout.title?.key).toBe('b');
    expect(layout.chip).toBeNull();
    expect(layout.meta.map((c) => c.key)).toEqual(['c']);
  });
});
