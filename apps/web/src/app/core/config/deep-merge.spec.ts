import { describe, expect, it } from 'vitest';
import { deepMerge } from './deep-merge';
import type { DeepPartial } from './deep-merge';

describe('deepMerge', () => {
  it('merges nested objects recursively', () => {
    const base = { a: 1, nested: { x: 1, y: 2 } };
    expect(deepMerge(base, { nested: { y: 99 } })).toEqual({
      a: 1,
      nested: { x: 1, y: 99 },
    });
  });

  it('replaces arrays instead of merging them', () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it('ignores undefined overrides, keeping the base value', () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it('lets null overrides replace explicitly', () => {
    // null is a runtime-level escape hatch, not part of the typed contract:
    // explicit "no value" from a JS caller.
    expect(deepMerge({ a: 1 }, { a: null } as unknown as DeepPartial<{ a: number }>)).toEqual({
      a: null,
    });
  });

  it('drops unknown keys from the override', () => {
    const merged = deepMerge({ a: 1 }, { b: 2 } as unknown as { a?: number });
    expect(merged).toEqual({ a: 1 });
    expect('b' in merged).toBe(false);
  });

  it('drops mistyped primitive overrides (keeps the typed base)', () => {
    const merged = deepMerge({ sqft: 2200 }, { sqft: '2200' } as unknown as { sqft?: number });
    expect(merged.sqft).toBe(2200);
  });

  it('drops object/primitive type mismatches at any depth', () => {
    const base = { wizard: { sqftDefault: 2200 }, api: { baseUrl: '/api/v1' } };
    const bad = { wizard: 'bad', api: { baseUrl: 42 } } as unknown as typeof base;
    const merged = deepMerge(base, bad);
    expect(merged.wizard).toEqual({ sqftDefault: 2200 });
    expect(merged.api.baseUrl).toBe('/api/v1');
  });

  it('replaces arrays only with arrays', () => {
    expect(deepMerge({ items: ['a'] }, { items: ['b', 'c'] }).items).toEqual(['b', 'c']);
    expect(deepMerge({ items: ['a'] }, { items: 'nope' } as never).items).toEqual(['a']);
  });

  it('returns the base untouched when the override is undefined', () => {
    const base = { a: 1 };
    expect(deepMerge(base, undefined)).toBe(base);
  });

  it('does not mutate the base object', () => {
    const base = { nested: { x: 1 } };
    deepMerge(base, { nested: { x: 2 } });
    expect(base.nested.x).toBe(1);
  });
});
