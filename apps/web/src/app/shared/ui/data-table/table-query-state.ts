import { type Signal, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, type Params, Router } from '@angular/router';
import {
  type TableFilters,
  type TableQuery,
  type TableQueryOptions,
  type TableSort,
  decodeTableQuery,
  encodeTableQuery,
} from './table-query';

/** URL-backed list state for one DataTable + FilterBar pair. */
export interface TableQueryState {
  readonly query: Signal<TableQuery>;
  readonly search: Signal<string>;
  readonly filters: Signal<TableFilters>;
  readonly sort: Signal<TableSort | null>;
  readonly page: Signal<number>;
  setSearch(search: string): void;
  setFilter(key: string, value: string | null): void;
  clearFilters(): void;
  setSort(sort: TableSort | null): void;
  setPage(page: number): void;
}

/**
 * Binds list state to the current route's query params. Call in an
 * injection context (field initialiser) of the page that hosts the list:
 *
 * ```ts
 * readonly list = injectTableQuery({ filterKeys: ['status'], sortKeys: ['name', 'created'] });
 * ```
 * ```html
 * <ui-filter-bar [search]="list.search()" [filters]="list.filters()"
 *   (searchChange)="list.setSearch($event)" (filterChange)="list.setFilter($event.key, $event.value)"
 *   (clearAll)="list.clearFilters()" ... />
 * <ui-data-table [sort]="list.sort()" (sortChange)="list.setSort($event)"
 *   [page]="list.page()" (pageChange)="list.setPage($event)" ... />
 * ```
 *
 * The URL is the single source of truth: setters navigate (replaceUrl, so
 * typing doesn't flood history; merge, so `?open=` survives) and the
 * signals re-read the params. Changing search, a filter or the sort resets
 * to page 1. Pages dispatch their NGXS load off `query()`.
 */
export function injectTableQuery(options: TableQueryOptions = {}): TableQueryState {
  const router = inject(Router);
  const route = inject(ActivatedRoute);
  const params = toSignal(route.queryParams, { initialValue: route.snapshot.queryParams as Params });

  const query = computed(() => decodeTableQuery(params(), options));

  const write = (next: TableQuery): void => {
    void router.navigate([], {
      relativeTo: route,
      queryParams: encodeTableQuery(next, options),
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  };

  return {
    query,
    search: computed(() => query().search),
    filters: computed(() => query().filters),
    sort: computed(() => query().sort),
    page: computed(() => query().page),
    setSearch: (search) => {
      if (search.trim() !== query().search) write({ ...query(), search, page: 1 });
    },
    setFilter: (key, value) => {
      const filters: Record<string, string> = { ...query().filters };
      if (value) filters[key] = value;
      else delete filters[key];
      write({ ...query(), filters, page: 1 });
    },
    clearFilters: () => write({ ...query(), search: '', filters: {}, page: 1 }),
    setSort: (sort) => write({ ...query(), sort, page: 1 }),
    setPage: (page) => write({ ...query(), page: Math.max(1, Math.floor(page)) }),
  };
}
