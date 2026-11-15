/**
 * DataTable / FilterBar list state <-> URL query params (portal-ui-kit §3:
 * "Synced to query params"). Pure — no Angular — so the codec is unit
 * tested on its own and shared by `injectTableQuery`.
 *
 * Wire format (all optional; defaults are omitted so clean URLs stay clean):
 *   q=<search>          free-text search
 *   sort=<key>|-<key>   ascending / descending ("-" prefix)
 *   page=<n>            1-based; page 1 is omitted
 *   <filterKey>=<value> one param per FilterBar select
 */

export type SortDirection = 'asc' | 'desc';

export interface TableSort {
  readonly key: string;
  readonly direction: SortDirection;
}

/** Active filter values by FilterBar select key. Absent key = no filter. */
export type TableFilters = Readonly<Record<string, string>>;

export interface TableQuery {
  readonly search: string;
  readonly filters: TableFilters;
  readonly sort: TableSort | null;
  readonly page: number;
}

export interface TableQueryOptions {
  /** FilterBar select keys this list understands. Unknown params are ignored. */
  readonly filterKeys?: readonly string[];
  /** Sortable column keys. A `sort` param naming anything else is dropped. */
  readonly sortKeys?: readonly string[];
  /** Sort applied when the URL has none (not written back to the URL). */
  readonly defaultSort?: TableSort | null;
  /** Param names; override when two lists share one route. */
  readonly searchParam?: string;
  readonly sortParam?: string;
  readonly pageParam?: string;
}

/** Raw params as Angular's `Params` (string, repeated → array). */
export type RawParams = Readonly<Record<string, unknown>>;

/** Encoded params; `null` removes the key under `queryParamsHandling: 'merge'`. */
export type EncodedParams = Record<string, string | null>;

export const EMPTY_TABLE_QUERY: TableQuery = { search: '', filters: {}, sort: null, page: 1 };

function first(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' ? v : null;
}

/** `name` → asc, `-name` → desc. Null for empty or (when given) unknown keys. */
export function parseSort(raw: string | null, allowed?: readonly string[]): TableSort | null {
  if (!raw) return null;
  const direction: SortDirection = raw.startsWith('-') ? 'desc' : 'asc';
  const key = direction === 'desc' ? raw.slice(1) : raw;
  if (!key || (allowed && !allowed.includes(key))) return null;
  return { key, direction };
}

export function serializeSort(sort: TableSort | null): string | null {
  if (!sort) return null;
  return sort.direction === 'desc' ? `-${sort.key}` : sort.key;
}

/** Header-click cycle: none → asc → desc → none. A different column starts at asc. */
export function nextSort(current: TableSort | null, key: string): TableSort | null {
  if (!current || current.key !== key) return { key, direction: 'asc' };
  return current.direction === 'asc' ? { key, direction: 'desc' } : null;
}

/**
 * Resolves a requested sort against the list's default. With a default,
 * "no sort" can't be represented in the URL (an absent param decodes back to
 * the default), so `null` means "back to the default" — and when the default
 * is already applied, the default column flips direction instead of getting
 * stuck. Header clicks on the default column therefore toggle asc ⇄ desc.
 */
export function resolveSort(
  requested: TableSort | null,
  current: TableSort | null,
  defaultSort: TableSort | null | undefined,
): TableSort | null {
  if (requested || !defaultSort) return requested;
  if (!sameSort(current, defaultSort)) return defaultSort;
  return { key: defaultSort.key, direction: defaultSort.direction === 'asc' ? 'desc' : 'asc' };
}

export function sameSort(a: TableSort | null, b: TableSort | null): boolean {
  return a?.key === b?.key && a?.direction === b?.direction;
}

/** Pages needed for `total` rows (0 rows → 0 pages). */
export function pageCount(total: number, pageSize: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(pageSize) || total <= 0 || pageSize <= 0) {
    return 0;
  }
  return Math.ceil(total / pageSize);
}

function parsePage(raw: string | null): number {
  if (!raw || !/^\d+$/.test(raw)) return 1;
  const n = Number(raw);
  return n >= 1 ? n : 1;
}

export function decodeTableQuery(params: RawParams, options: TableQueryOptions = {}): TableQuery {
  const filters: Record<string, string> = {};
  for (const key of options.filterKeys ?? []) {
    const value = first(params[key]);
    if (value) filters[key] = value;
  }
  return {
    search: first(params[options.searchParam ?? 'q'])?.trim() ?? '',
    filters,
    sort:
      parseSort(first(params[options.sortParam ?? 'sort']), options.sortKeys) ??
      options.defaultSort ??
      null,
    page: parsePage(first(params[options.pageParam ?? 'page'])),
  };
}

/**
 * Every param the list owns, with defaults as `null` so a merge navigation
 * removes them (and leaves unrelated params like `?open=` alone).
 */
export function encodeTableQuery(query: TableQuery, options: TableQueryOptions = {}): EncodedParams {
  const out: EncodedParams = {};
  for (const key of options.filterKeys ?? []) {
    out[key] = query.filters[key] || null;
  }
  const defaultSort = options.defaultSort ?? null;
  out[options.searchParam ?? 'q'] = query.search.trim() || null;
  out[options.sortParam ?? 'sort'] = sameSort(query.sort, defaultSort) ? null : serializeSort(query.sort);
  out[options.pageParam ?? 'page'] = query.page > 1 ? String(query.page) : null;
  return out;
}

/** Count of active filters (search excluded) — the mobile "Filters (n)" badge. */
export function activeFilterCount(filters: TableFilters): number {
  return Object.values(filters).filter((v) => !!v).length;
}
