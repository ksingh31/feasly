import { describe, expect, it } from 'vitest';
import {
  builderNameFor,
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
