import { invoiceTaxBreakdown, previewTaxCents } from './invoice-tax';

describe('invoiceTaxBreakdown (#764)', () => {
  it('returns null for an untaxed invoice (taxCents 0)', () => {
    expect(
      invoiceTaxBreakdown(
        { commissionCents: 18_750_00, subtotalCents: 18_750_00, taxCents: 0, totalCents: 18_750_00, taxRatePercent: 0, taxLabel: null },
        'Tax',
      ),
    ).toBeNull();
  });

  it('returns null when the tax fields are absent (pre-#714 shape)', () => {
    expect(invoiceTaxBreakdown({ commissionCents: 100 }, 'Tax')).toBeNull();
  });

  it('passes the server figures through and builds the tax line', () => {
    expect(
      invoiceTaxBreakdown(
        { commissionCents: 18_750_00, subtotalCents: 18_750_00, taxCents: 937_50, totalCents: 19_687_50, taxRatePercent: 5, taxLabel: 'GST' },
        'Tax',
      ),
    ).toEqual({
      subtotalCents: 18_750_00,
      taxCents: 937_50,
      totalCents: 19_687_50,
      taxLine: 'GST (5%)',
      label: 'GST',
    });
  });

  it('falls back to the configured label and omits a missing rate', () => {
    const b = invoiceTaxBreakdown({ commissionCents: 1000, taxCents: 50, totalCents: 1050, taxLabel: '  ' }, 'Tax');
    expect(b?.taxLine).toBe('Tax');
    expect(b?.subtotalCents).toBe(1000);
  });
});

describe('previewTaxCents (#764)', () => {
  it('estimates tax on a commission at the configured rate', () => {
    expect(previewTaxCents(18_750_00, 5)).toBe(937_50);
    expect(previewTaxCents(187_50, 5)).toBe(9_38);
  });
});
