import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  decodeTableQuery,
  encodeTableQuery,
  nextSort,
  pageCount,
  parseSort,
  serializeSort,
  type TableQueryOptions,
} from './table-query';

const OPTS: TableQueryOptions = { filterKeys: ['status', 'builder'], sortKeys: ['name', 'created'] };

describe('sort codec', () => {
  it('parses asc / desc and rejects unknown keys', () => {
    expect(parseSort('name')).toEqual({ key: 'name', direction: 'asc' });
    expect(parseSort('-created')).toEqual({ key: 'created', direction: 'desc' });
    expect(parseSort('-')).toBeNull();
    expect(parseSort('')).toBeNull();
    expect(parseSort('secret', ['name'])).toBeNull();
  });

  it('serialises back to the same string', () => {
    for (const raw of ['name', '-created']) {
      expect(serializeSort(parseSort(raw))).toBe(raw);
    }
    expect(serializeSort(null)).toBeNull();
  });

  it('cycles none → asc → desc → none, restarting on a new column', () => {
    const a = nextSort(null, 'name');
    expect(a).toEqual({ key: 'name', direction: 'asc' });
    const d = nextSort(a, 'name');
    expect(d).toEqual({ key: 'name', direction: 'desc' });
    expect(nextSort(d, 'name')).toBeNull();
    expect(nextSort(d, 'created')).toEqual({ key: 'created', direction: 'asc' });
  });
});

describe('pageCount', () => {
  it('rounds up and treats bad input as zero pages', () => {
    expect(pageCount(0, 25)).toBe(0);
    expect(pageCount(25, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
    expect(pageCount(10, 0)).toBe(0);
    expect(pageCount(Number.NaN, 25)).toBe(0);
  });
});

describe('decode / encode', () => {
  it('decodes known params and ignores the rest', () => {
    const q = decodeTableQuery(
      { q: ' marco ', sort: '-created', page: '3', status: 'open', open: 'abc', other: 'x' },
      OPTS,
    );
    expect(q).toEqual({ search: 'marco', filters: { status: 'open' }, sort: { key: 'created', direction: 'desc' }, page: 3 });
  });

  it('falls back to safe defaults for junk', () => {
    expect(decodeTableQuery({ sort: 'password', page: '-2', status: '' }, OPTS)).toEqual({
      search: '',
      filters: {},
      sort: null,
      page: 1,
    });
    expect(decodeTableQuery({ page: '2.5' }, OPTS).page).toBe(1);
    expect(decodeTableQuery({ status: ['won', 'lost'] }, OPTS).filters).toEqual({ status: 'won' });
  });

  it('applies the default sort without writing it to the URL', () => {
    const opts = { ...OPTS, defaultSort: { key: 'created', direction: 'desc' as const } };
    const q = decodeTableQuery({}, opts);
    expect(q.sort).toEqual({ key: 'created', direction: 'desc' });
    expect(encodeTableQuery(q, opts)['sort']).toBeNull();
  });

  it('encodes every owned key, nulling defaults so a merge removes them', () => {
    expect(encodeTableQuery({ search: '', filters: {}, sort: null, page: 1 }, OPTS)).toEqual({
      status: null,
      builder: null,
      q: null,
      sort: null,
      page: null,
    });
  });

  it('round-trips through encode → decode', () => {
    const q = { search: 'silva', filters: { status: 'won', builder: 'b1' }, sort: { key: 'name', direction: 'asc' as const }, page: 4 };
    const params = Object.fromEntries(
      Object.entries(encodeTableQuery(q, OPTS)).filter(([, v]) => v !== null),
    );
    expect(decodeTableQuery(params, OPTS)).toEqual(q);
  });

  it('honours custom param names', () => {
    const opts = { ...OPTS, searchParam: 'lq', sortParam: 'lsort', pageParam: 'lpage' };
    expect(decodeTableQuery({ lq: 'a', lsort: 'name', lpage: '2' }, opts)).toMatchObject({
      search: 'a',
      sort: { key: 'name' },
      page: 2,
    });
  });

  it('counts active filters', () => {
    expect(activeFilterCount({ a: 'x', b: '' })).toBe(1);
  });
});
