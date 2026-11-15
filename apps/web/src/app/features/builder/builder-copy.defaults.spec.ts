/**
 * Issue #479: card-charge timing copy must not contradict itself. Every
 * card-charge timing message uses the one owner-approved sentence, and the
 * due banners share the invoices table's status vocabulary.
 */
import { describe, expect, it } from 'vitest';
import {
  CHARGE_TIMING_COPY,
  DEFAULT_BUILDER_COPY,
} from './builder-copy.defaults';

describe('builder charge-timing copy (#479)', () => {
  it('is the owner-approved sentence', () => {
    expect(CHARGE_TIMING_COPY).toBe(
      'We charge your card 7 days after the invoice is issued. You can question it any time before then.',
    );
  });

  it.each([
    'billingExplainer',
    'billingCardEmptyBody',
    'billingCardSaved',
    'reportContractSuccessBody',
    'invoicesReviewNote',
  ] as const)('%s uses the approved sentence verbatim', (key) => {
    expect(DEFAULT_BUILDER_COPY[key]).toContain(CHARGE_TIMING_COPY);
  });

  it('has no competing charge-timing phrasings', () => {
    const all = Object.values(DEFAULT_BUILDER_COPY)
      .filter((v): v is string => typeof v === 'string')
      .join('\n');
    expect(all).not.toMatch(/auto-charges? 7 days/i);
    expect(all).not.toMatch(/after each (7-day )?review window/i);
    expect(all).not.toMatch(/charge your card on file after the review/i);
  });

  it('banners use the table status vocabulary, never "overdue"', () => {
    const banners = [
      DEFAULT_BUILDER_COPY.dueBannersBarFailedLead,
      DEFAULT_BUILDER_COPY.dueBannersBarDueTodayLead,
      DEFAULT_BUILDER_COPY.dueBannersBarOverdueLead,
    ];
    for (const lead of banners) {
      expect(lead.toLowerCase()).not.toContain('overdue');
    }
    expect(DEFAULT_BUILDER_COPY.dueBannersBarFailedLead.toLowerCase()).toContain(
      DEFAULT_BUILDER_COPY.invoiceStatusFailed.toLowerCase(),
    );
    expect(DEFAULT_BUILDER_COPY.dueBannersBarDueTodayLead.toLowerCase()).toContain(
      DEFAULT_BUILDER_COPY.invoiceStatusInReview.toLowerCase(),
    );
    expect(DEFAULT_BUILDER_COPY.dueBannersBarOverdueLead.toLowerCase()).toContain(
      DEFAULT_BUILDER_COPY.invoiceStatusInReview.toLowerCase(),
    );
  });
});
