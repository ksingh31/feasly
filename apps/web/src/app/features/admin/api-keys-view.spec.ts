import { FormControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import type { Builder } from '@feasly/contracts';
import {
  apiKeyStatus,
  builderName,
  builderOptions,
  dayLabel,
  fill,
  parseRateLimit,
  rateLimitValidator,
  scopesValidator,
  usageByDay,
} from './api-keys-view';

const BUILDERS = [{ tenantKey: 'elite-craft', displayName: 'Elite Craft' }] as Builder[];

describe('api-keys-view (#546)', () => {
  it('derives the status from revoked_at', () => {
    expect(apiKeyStatus({ revoked_at: null })).toBe('active');
    expect(apiKeyStatus({ revoked_at: '2026-10-01T00:00:00Z' })).toBe('revoked');
  });

  it('maps builders to combobox options keyed by tenant key', () => {
    expect(builderOptions(BUILDERS)).toEqual([{ id: 'elite-craft', label: 'Elite Craft', meta: 'elite-craft' }]);
  });

  it('resolves builder names, falling back to the raw key', () => {
    expect(builderName('elite-craft', BUILDERS)).toBe('Elite Craft');
    expect(builderName('gone', BUILDERS)).toBe('gone');
    expect(builderName(null, BUILDERS)).toBeNull();
  });

  it('parses and validates the rate limit', () => {
    expect(parseRateLimit(' 60 ')).toBe(60);
    expect(parseRateLimit('1.5')).toBeNull();
    expect(parseRateLimit('')).toBeNull();
    const v = rateLimitValidator(100);
    expect(v(new FormControl('100'))).toBeNull();
    expect(v(new FormControl('101'))).toEqual({ rateLimit: true });
    expect(v(new FormControl('0'))).toEqual({ rateLimit: true });
  });

  it('requires a scope', () => {
    expect(scopesValidator(new FormControl([]))).toEqual({ scopes: true });
    expect(scopesValidator(new FormControl(['estimate']))).toBeNull();
  });

  it('sums usage per day, oldest first, scaled to the busiest day', () => {
    const days = usageByDay([
      { date: '2026-11-14', endpoint: 'a', count: 3, estimates_created: 0 },
      { date: '2026-11-13', endpoint: 'a', count: 2, estimates_created: 0 },
      { date: '2026-11-14', endpoint: 'b', count: 1, estimates_created: 0 },
    ]);
    expect(days.map((d) => [d.date, d.count, d.share])).toEqual([
      ['2026-11-13', 2, 0.5],
      ['2026-11-14', 4, 1],
    ]);
    expect(days.map((d) => d.tick)).toEqual(['13', '14']);
    expect(usageByDay([])).toEqual([]);
  });

  it('labels days in the calendar day given', () => {
    expect(dayLabel('2026-11-01')).toBe('Nov 1');
    expect(dayLabel('nope')).toBe('nope');
  });

  it('fills placeholders', () => {
    expect(fill('Rotate {name}?', { name: 'A' })).toBe('Rotate A?');
    expect(fill('{x}', {})).toBe('{x}');
  });
});
