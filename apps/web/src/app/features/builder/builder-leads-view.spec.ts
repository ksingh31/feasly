import { describe, expect, it } from 'vitest';
import type { BuilderLeadListItem } from '@feasly/contracts';
import {
  fill,
  heatChipLabel,
  heatLevel,
  leadMatchesSearch,
  mailtoHref,
  pageOf,
  parseStatusFilter,
  projectTypeLabel,
  selectPipelineLeads,
  telHref,
} from './builder-leads-view';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';

function lead(overrides: Partial<BuilderLeadListItem>): BuilderLeadListItem {
  return {
    id: 'l',
    name: 'Jane Homeowner',
    email: 'jane@example.com',
    phone: '403-555-0101',
    timeline: '3–6 months',
    leadScore: 70,
    status: 'new',
    statusUpdatedAt: '2026-11-01T10:00:00.000Z',
    addressKey: '123 Main St SW',
    projectType: 'new-build',
    createdAt: '2026-10-30T10:00:00.000Z',
    hasInvoice: false,
    invoiceSummary: null,
    commentCount: 0,
    latestComment: null,
    needsRecording: false,
    ...overrides,
  };
}

const LEADS = [
  lead({ id: 'a', name: 'Zed Adams', status: 'new', statusUpdatedAt: '2026-11-03T10:00:00.000Z' }),
  lead({
    id: 'b',
    name: 'amy Brown',
    status: 'contacted',
    email: 'amy@b.ca',
    phone: null,
    statusUpdatedAt: '2026-11-01T10:00:00.000Z',
  }),
  lead({ id: 'c', name: 'Moe Chan', status: 'won', addressKey: '9 Elbow Dr SW', statusUpdatedAt: '2026-11-02T10:00:00.000Z' }),
];

const HEAT = DEFAULT_BUILDER_COPY.leadsHome.heat;

describe('heatLevel (builder review: Hot ≥85, Warm 65–84, Cool <65)', () => {
  it.each([
    [100, 'hot'],
    [85, 'hot'],
    [84, 'warm'],
    [65, 'warm'],
    [64, 'cool'],
    [0, 'cool'],
  ] as const)('%i → %s', (score, heat) => {
    expect(heatLevel(score, HEAT)).toBe(heat);
  });

  it('labels the pill with heat and score', () => {
    expect(heatChipLabel(92, HEAT)).toBe('Hot · 92');
    expect(heatChipLabel(40, HEAT)).toBe('Cool · 40');
  });
});

describe('parseStatusFilter', () => {
  it('accepts pipeline statuses only', () => {
    expect(parseStatusFilter('won')).toBe('won');
    expect(parseStatusFilter('quoting')).toBeNull();
    expect(parseStatusFilter(undefined)).toBeNull();
    expect(parseStatusFilter('')).toBeNull();
  });
});

describe('leadMatchesSearch', () => {
  it('matches name, email and address case-insensitively', () => {
    expect(leadMatchesSearch(LEADS[0], 'zed')).toBe(true);
    expect(leadMatchesSearch(LEADS[1], 'AMY@B')).toBe(true);
    expect(leadMatchesSearch(LEADS[2], 'elbow')).toBe(true);
    expect(leadMatchesSearch(LEADS[2], 'nobody')).toBe(false);
  });

  it('matches phone digits regardless of formatting', () => {
    expect(leadMatchesSearch(LEADS[0], '(403) 555')).toBe(true);
    expect(leadMatchesSearch(LEADS[1], '403')).toBe(false);
  });

  it('empty search matches everything', () => {
    expect(leadMatchesSearch(LEADS[1], '  ')).toBe(true);
  });
});

describe('selectPipelineLeads', () => {
  const ids = (rows: readonly BuilderLeadListItem[]) => rows.map((r) => r.id);

  it('filters by status and search together', () => {
    expect(ids(selectPipelineLeads(LEADS, { status: 'won', search: '', sort: null }))).toEqual(['c']);
    expect(ids(selectPipelineLeads(LEADS, { status: null, search: 'a', sort: null }))).toEqual(['a', 'b', 'c']);
    expect(ids(selectPipelineLeads(LEADS, { status: 'new', search: 'moe', sort: null }))).toEqual([]);
  });

  it('sorts by activity and by name, both directions, without mutating', () => {
    const copy = [...LEADS];
    expect(
      ids(selectPipelineLeads(LEADS, { status: null, search: '', sort: { key: 'activity', direction: 'desc' } })),
    ).toEqual(['a', 'c', 'b']);
    expect(
      ids(selectPipelineLeads(LEADS, { status: null, search: '', sort: { key: 'activity', direction: 'asc' } })),
    ).toEqual(['b', 'c', 'a']);
    expect(
      ids(selectPipelineLeads(LEADS, { status: null, search: '', sort: { key: 'lead', direction: 'asc' } })),
    ).toEqual(['b', 'c', 'a']);
    expect(LEADS).toEqual(copy);
  });
});

describe('pageOf', () => {
  it('slices 1-based pages; pageSize 0 disables paging', () => {
    const rows = [1, 2, 3, 4, 5];
    expect(pageOf(rows, 1, 2)).toEqual([1, 2]);
    expect(pageOf(rows, 3, 2)).toEqual([5]);
    expect(pageOf(rows, 0, 2)).toEqual([1, 2]);
    expect(pageOf(rows, 2, 0)).toEqual(rows);
  });
});

describe('formatting', () => {
  it('labels project types from config, humanising unknown values', () => {
    const labels = DEFAULT_BUILDER_COPY.leadsHome.projectTypes;
    expect(projectTypeLabel('new-build', labels)).toBe('New build');
    expect(projectTypeLabel('new_build', labels)).toBe('New build');
    expect(projectTypeLabel('laneway_suite', labels)).toBe('Laneway suite');
  });

  it('builds tel: and mailto: hrefs (#475)', () => {
    expect(telHref(' (403) 555-0101 ')).toBe('tel:4035550101');
    expect(telHref('+1 403 555 0101')).toBe('tel:+14035550101');
    expect(mailtoHref(' jane@example.com ')).toBe('mailto:jane@example.com');
  });

  it('fills placeholders and leaves unknown ones', () => {
    expect(fill('Call {name}', { name: 'Jane' })).toBe('Call Jane');
    expect(fill('{days}+ {x}', { days: 7 })).toBe('7+ {x}');
  });
});
