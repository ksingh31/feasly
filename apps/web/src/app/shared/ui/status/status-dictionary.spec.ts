import { describe, expect, it } from 'vitest';
import {
  STATUS_DICTIONARY,
  type StatusDomain,
  type StatusTone,
  disputeSlaKey,
  enumLabel,
  statusPresentation,
} from './status-dictionary';

/** The spec table from docs/design/portal-ui-kit.md §2, verbatim. */
const SPEC_TABLE: ReadonlyArray<readonly [StatusDomain, string, StatusTone, string]> = [
  ['lead', 'new', 'info', 'New'],
  ['lead', 'contacted', 'progress', 'Contacted'],
  ['lead', 'quoting', 'warning', 'Quoting'],
  ['lead', 'won', 'success', 'Won'],
  ['lead', 'lost', 'neutral', 'Lost'],
  ['invoice', 'draft', 'neutral', 'Draft'],
  ['invoice', 'in_review', 'warning', 'In review'],
  ['invoice', 'finalized', 'info', 'Finalized'],
  ['invoice', 'paid', 'success', 'Paid'],
  ['invoice', 'failed', 'danger', 'Failed'],
  ['invoice', 'disputed', 'paused', 'Disputed'],
  ['invoice', 'void', 'neutral', 'Void'],
  ['member', 'active', 'success', 'Active'],
  ['member', 'invited', 'info', 'Invited'],
  ['member', 'deactivated', 'neutral', 'Deactivated'],
  ['builder', 'active', 'success', 'Active'],
  ['builder', 'past_due', 'warning', 'Past due'],
  ['builder', 'degraded', 'danger', 'Degraded'],
  ['builder', 'suspended', 'danger', 'Suspended'],
  ['apiKey', 'active', 'success', 'Active'],
  ['apiKey', 'revoked', 'neutral', 'Revoked'],
  ['disputeSla', 'on_track', 'neutral', 'On track'],
  ['disputeSla', 'due_today', 'warning', 'Due today'],
  ['disputeSla', 'overdue', 'danger', 'Overdue'],
];

const SENTENCE_CASE = /^[A-Z][a-z0-9 -]*$/;

describe('status dictionary', () => {
  it.each(SPEC_TABLE)('%s/%s → %s "%s"', (domain, status, tone, label) => {
    expect(statusPresentation(domain, status)).toEqual({ tone, label });
  });

  it('maps the wire-only aliases from @feasly/contracts', () => {
    expect(statusPresentation('lead', 'quoted')).toEqual({ label: 'Quoted', tone: 'warning' });
    expect(statusPresentation('member', 'disabled')).toEqual({
      label: 'Deactivated',
      tone: 'neutral',
    });
    expect(statusPresentation('builder', 'inactive')).toEqual({
      label: 'Inactive',
      tone: 'neutral',
    });
  });

  it('every entry has a sentence-case label and never echoes a raw enum', () => {
    for (const [domain, map] of Object.entries(STATUS_DICTIONARY)) {
      for (const [status, { label }] of Object.entries(map)) {
        expect(label, `${domain}/${status}`).toMatch(SENTENCE_CASE);
        expect(label).not.toContain('_');
      }
    }
  });

  it('falls back to a neutral humanised label for unknown statuses', () => {
    expect(statusPresentation('invoice', 'partially_refunded')).toEqual({
      label: 'Partially refunded',
      tone: 'neutral',
    });
    expect(statusPresentation('lead', null)).toEqual({ label: '—', tone: 'neutral' });
  });

  it('does not resolve prototype keys as statuses', () => {
    expect(statusPresentation('lead', 'toString')).toEqual({
      label: 'Tostring',
      tone: 'neutral',
    });
  });
});

describe('enumLabel', () => {
  it.each([
    ['new_build', 'New build'],
    ['renovation', 'Renovation'],
    ['e_transfer', 'E-transfer'],
    ['bank_draft', 'Bank draft'],
    ['card_terminal', 'Card terminal'],
    ['builder-admin', 'Builder admin'],
    ['SUPER_ADMIN', 'Super admin'],
    ['api_key', 'API key'],
  ])('%s → %s', (value, label) => {
    expect(enumLabel(value)).toBe(label);
  });

  it('renders an em dash for empty input', () => {
    expect(enumLabel('')).toBe('—');
    expect(enumLabel(undefined)).toBe('—');
  });
});

describe('disputeSlaKey', () => {
  it.each([
    [5, 'on_track'],
    [1, 'on_track'],
    [0, 'due_today'],
    [-1, 'overdue'],
  ] as const)('%i days left → %s', (days, key) => {
    expect(disputeSlaKey(days)).toBe(key);
  });
});
