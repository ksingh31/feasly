import { describe, expect, it } from 'vitest';
import type { BillingHealthDunningInvoice } from '@feasly/contracts';
import { DEFAULT_ADMIN_COPY } from './admin-copy.defaults';
import {
  awaitingManualLabel,
  builderNameFor,
  cancelRetriesConfirmOptions,
  dunningStateLabel,
  graceDaysLabel,
  parseGraceDays,
  sortDunningRows,
  daysOverdue,
  ratePercentLabel,
  retriesExhausted,
  retryConfirmOptions,
  retryLabel,
  stripeModeKey,
} from './admin-billing-view';

describe('admin-billing-view (#544)', () => {
  it('maps the Stripe config to a header chip key', () => {
    expect(stripeModeKey({ configured: false, testMode: false })).toBe('not_configured');
    expect(stripeModeKey({ configured: true, testMode: true })).toBe('test');
    expect(stripeModeKey({ configured: true, testMode: false })).toBe('live');
  });

  it('names a builder from the list, falling back to the tenant key', () => {
    const builders = [
      { tenantKey: 'a', displayName: 'Alpha Homes', businessName: 'Alpha Homes Ltd.' },
      { tenantKey: 'b', displayName: '', businessName: 'Beta Builders Inc.' },
    ];
    expect(builderNameFor(builders, 'a')).toBe('Alpha Homes');
    expect(builderNameFor(builders, 'b')).toBe('Beta Builders Inc.');
    expect(builderNameFor(builders, 'zzz')).toBe('zzz');
  });

  it('formats rates, overdue days and retry labels', () => {
    expect(ratePercentLabel(1.16670000001)).toBe('1.1667%');
    expect(daysOverdue('2026-11-10T12:00:00.000Z', new Date('2026-11-15T13:00:00.000Z'))).toBe(5);
    expect(daysOverdue('not a date')).toBe(0);
    expect(retryLabel(1, 3)).toBe('Retry 2 of 3');
    expect(retryLabel(1, undefined)).toBe('Retry charge');
    expect(retriesExhausted(3, 3)).toBe(true);
    expect(retriesExhausted(2, 3)).toBe(false);
  });

  it('builds a retry confirm that names the amount and the builder', () => {
    const options = retryConfirmOptions({
      builderName: 'Elite Craft Builders',
      commissionCents: 1_980_000,
      retryCount: 1,
      maxRetries: 3,
    });
    expect(options.title).toBe('Retry $19,800 charge for Elite Craft Builders?');
    expect(options.body).toContain('$19,800');
    expect(options.body).toContain('Elite Craft Builders');
    expect(options.body).toContain('retry 2 of 3');
    expect(options.verb).toBe('Retry charge');
  });
});

describe('admin-billing-view dunning helpers (#901)', () => {
  const D = DEFAULT_ADMIN_COPY.dunning;
  const row = (patch: Partial<BillingHealthDunningInvoice>): BillingHealthDunningInvoice =>
    ({ id: 'x', collectionsAt: null, dunningState: 'active', ...patch }) as BillingHealthDunningInvoice;

  it('sorts collections first (oldest flag first) and keeps the rest in API order', () => {
    const rows = [
      row({ id: 'a' }),
      row({ id: 'b', collectionsAt: '2026-11-12T00:00:00.000Z' }),
      row({ id: 'c' }),
      row({ id: 'd', collectionsAt: '2026-11-10T00:00:00.000Z' }),
    ];
    expect(sortDunningRows(rows).map((r) => r.id)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('labels the state, with the collections age taking precedence', () => {
    const now = new Date('2026-11-16T12:00:00.000Z');
    expect(dunningStateLabel(row({}), D, now)).toBe(D.stateActive);
    expect(dunningStateLabel(row({ dunningState: 'paused' }), D, now)).toBe(D.statePaused);
    expect(dunningStateLabel(row({ dunningState: 'cancelled' }), D, now)).toBe(D.stateCancelled);
    expect(dunningStateLabel(row({ collectionsAt: '2026-11-15T12:00:00.000Z' }), D, now)).toBe('Collections · 1 day');
    expect(dunningStateLabel(row({ collectionsAt: '2026-11-12T12:00:00.000Z' }), D, now)).toBe('Collections · 4 days');
  });

  it('labels grace days and manual-payment age', () => {
    expect(graceDaysLabel(1, D)).toBe('1 day');
    expect(graceDaysLabel(7, D)).toBe('7 days');
    expect(awaitingManualLabel({ paymentMethod: 'cheque', overdueDays: 3 }, D)).toBe('Awaiting manual payment — 3 days');
    expect(awaitingManualLabel({ paymentMethod: 'cheque', overdueDays: 1 }, D)).toBe('Awaiting manual payment — 1 day');
    expect(awaitingManualLabel({ paymentMethod: 'cheque', overdueDays: 0 }, D)).toBe(D.notOverdue);
    expect(awaitingManualLabel({ paymentMethod: 'card', overdueDays: 5 }, D)).toBe(D.notOverdue);
  });

  it('parses grace days as a whole number within bounds', () => {
    expect(parseGraceDays(' 14 ', 1, 90)).toBe(14);
    expect(parseGraceDays('1', 1, 90)).toBe(1);
    expect(parseGraceDays('90', 1, 90)).toBe(90);
    for (const bad of ['', '0', '91', '1.5', '-3', 'ten']) expect(parseGraceDays(bad, 1, 90)).toBeNull();
  });

  it('builds a danger confirm naming the builder and amount for Cancel', () => {
    const opts = cancelRetriesConfirmOptions({ builderName: 'Elite Craft', commissionCents: 15_000 }, D);
    expect(opts.title).toBe('Cancel automatic retries for Elite Craft?');
    expect(opts.body).toContain('$150');
    expect(opts.tone).toBe('danger');
  });
});
