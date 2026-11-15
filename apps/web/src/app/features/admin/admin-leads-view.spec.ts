import { describe, expect, it } from 'vitest';
import { fill, leadsFilters, parseStatus, parseView, viewFilters } from './admin-leads-view';

/** #539 — saved views + URL filters → backend filters. */
describe('admin-leads-view', () => {
  const NOW = new Date('2026-11-15T12:00:00.000Z');

  it('parses known views and falls back to all', () => {
    expect(parseView('new')).toBe('new');
    expect(parseView('unassigned')).toBe('unassigned');
    expect(parseView('quoting-stale')).toBe('quoting-stale');
    expect(parseView('bogus')).toBe('all');
    expect(parseView(undefined)).toBe('all');
  });

  it('parses pipeline statuses only', () => {
    expect(parseStatus('quoting')).toBe('quoting');
    expect(parseStatus('quoted')).toBeNull();
    expect(parseStatus(null)).toBeNull();
  });

  it('maps each saved view to backend filters', () => {
    expect(viewFilters('all', NOW, 7)).toEqual({});
    expect(viewFilters('new', NOW, 7)).toEqual({ status: 'new' });
    expect(viewFilters('unassigned', NOW, 7)).toEqual({ builderId: 'unassigned' });
    expect(viewFilters('quoting-stale', NOW, 7)).toEqual({
      status: 'quoting',
      createdBefore: '2026-11-08T12:00:00.000Z',
    });
  });

  it('layers explicit filters and search over the view preset', () => {
    expect(
      leadsFilters('  ava ', { view: 'new', assigned: 'b-1' }, NOW, 7),
    ).toEqual({ status: 'new', builderId: 'b-1', search: 'ava' });
    expect(leadsFilters('', { view: 'unassigned', status: 'won' }, NOW, 7)).toEqual({
      builderId: 'unassigned',
      status: 'won',
    });
    expect(leadsFilters('', { status: 'nope' }, NOW, 7)).toEqual({});
  });

  it('fills placeholders and leaves unknown ones', () => {
    expect(fill('Quoting > {days} days', { days: 7 })).toBe('Quoting > 7 days');
    expect(fill('{a} {b}', { a: 1 })).toBe('1 {b}');
  });
});
