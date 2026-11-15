/**
 * AC2 (#500): sort + filter state round-trips through the URL.
 * Drives the real DataTable + FilterBar against the real Router.
 */
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { describe, expect, it } from 'vitest';
import { FilterBarComponent, type FilterBarSelect } from '../filter-bar/filter-bar.component';
import type { DataTableColumn } from './data-table';
import { DataTableComponent } from './data-table.component';
import { injectTableQuery } from './table-query-state';

interface Row {
  id: string;
  name: string;
  amount: number;
}

@Component({
  standalone: true,
  imports: [DataTableComponent, FilterBarComponent],
  template: `
    <ui-filter-bar
      [search]="list.search()"
      [filters]="list.filters()"
      [selects]="selects"
      [debounceMs]="0"
      (searchChange)="list.setSearch($event)"
      (filterChange)="list.setFilter($event.key, $event.value)"
      (clearAll)="list.clearFilters()"
    />
    <ui-data-table
      label="Rows"
      [rows]="rows"
      [columns]="columns"
      [rowId]="rowId"
      [sort]="list.sort()"
      [page]="list.page()"
      [pageSize]="1"
      [total]="3"
      (sortChange)="list.setSort($event)"
      (pageChange)="list.setPage($event)"
    />
  `,
})
class ListPage {
  readonly list = injectTableQuery({ filterKeys: ['status'], sortKeys: ['name', 'amount'] });
  readonly selects: FilterBarSelect[] = [
    { key: 'status', label: 'Status', placeholder: 'Any', options: [{ value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }] },
  ];
  readonly rows: Row[] = [{ id: 'a', name: 'A', amount: 100 }];
  readonly columns: DataTableColumn<Row>[] = [
    { key: 'name', header: 'Name', sortable: true },
    { key: 'amount', header: 'Amount', kind: 'money', sortable: true },
  ];
  readonly rowId = (r: Row): string => r.id;
}

async function boot(url: string): Promise<{ harness: RouterTestingHarness; router: Router }> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideRouter([{ path: 'list', component: ListPage }])] });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  return { harness, router: TestBed.inject(Router) };
}

/** Polls until the router settles on a URL matching `predicate` (no fixed sleeps). */
async function urlWhen(router: Router, harness: RouterTestingHarness, predicate: (url: string) => boolean): Promise<string> {
  const deadline = Date.now() + 2000;
  while (!predicate(router.url)) {
    if (Date.now() > deadline) throw new Error(`URL never matched; last: ${router.url}`);
    await harness.fixture.whenStable();
    // Yield a macrotask so timer(0) debounces and router navigations flush.
    await new Promise((r) => setTimeout(r, 0));
  }
  harness.detectChanges();
  return router.url;
}

describe('injectTableQuery — URL round-trip', () => {
  it('writes sort, filter and page to the URL, preserving unrelated params', async () => {
    const { harness, router } = await boot('/list?open=xyz');
    const el = harness.routeNativeElement as HTMLElement;

    (el.querySelector('thead th button') as HTMLButtonElement).click();
    await urlWhen(router, harness, (u) => u.includes('sort=name'));

    const select = el.querySelector('ui-filter-bar .ui-fb__bar select') as HTMLSelectElement;
    select.value = 'won';
    select.dispatchEvent(new Event('change'));
    await urlWhen(router, harness, (u) => u.includes('status=won'));

    (el.querySelector('.ui-dt__pager button:last-child') as HTMLButtonElement).click();
    const url = await urlWhen(router, harness, (u) => u.includes('page=2'));
    expect(url).toContain('open=xyz');

    // Changing the sort resets to page 1 (param removed).
    (el.querySelectorAll('thead th button')[0] as HTMLButtonElement).click();
    const after = await urlWhen(router, harness, (u) => u.includes('sort=-name'));
    expect(after).not.toContain('page=');
    expect(after).toContain('status=won');
  });

  it('restores sort and filter state from a URL on a fresh load', async () => {
    const { harness } = await boot('/list?sort=-amount&status=lost&q=silva&page=2');
    const el = harness.routeNativeElement as HTMLElement;
    const [name, amount] = Array.from(el.querySelectorAll('thead th'));
    expect(name.getAttribute('aria-sort')).toBe('none');
    expect(amount.getAttribute('aria-sort')).toBe('descending');
    expect((el.querySelector('input[type=search]') as HTMLInputElement).value).toBe('silva');
    expect((el.querySelector('.ui-fb__bar select') as HTMLSelectElement).value).toBe('lost');
    expect(el.querySelector('.ui-fb__chip')?.textContent).toContain('Status: Lost');
    expect(el.querySelector('.ui-dt__pager')?.textContent).toContain('Page 2 of 3');
  });

  it('Clear all removes search and filters but keeps the sort', async () => {
    const { harness, router } = await boot('/list?sort=name&status=won&q=a');
    const el = harness.routeNativeElement as HTMLElement;
    (el.querySelector('.ui-fb__chips .ui-fb__clear') as HTMLButtonElement).click();
    const url = await urlWhen(router, harness, (u) => !u.includes('status='));
    expect(url).toBe('/list?sort=name');
  });

  it('search typed in the FilterBar lands in the URL', async () => {
    const { harness, router } = await boot('/list');
    const el = harness.routeNativeElement as HTMLElement;
    const input = el.querySelector('input[type=search]') as HTMLInputElement;
    input.value = 'marco';
    input.dispatchEvent(new Event('input'));
    const url = await urlWhen(router, harness, (u) => u.includes('q=marco'));
    expect(url).toBe('/list?q=marco');
  });
});
