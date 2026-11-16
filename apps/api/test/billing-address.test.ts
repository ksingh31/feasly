/** #881: billing address validation + normalization (pure lib). */
import { describe, expect, it } from 'vitest';
import {
  billingAddressSchema,
  isCanadianPostalCode,
  normalizeCanadianPostalCode,
  sameBillingAddress,
} from '../src/lib/billing-address';

const BASE = { line1: '100 8 Ave SW', city: 'Calgary', province: 'AB', postalCode: 'T2P 1J9' };

describe('Canadian postal codes', () => {
  it.each(['T2P 1J9', 't2p1j9', 'T2P-1J9', 'K1A 0B1', 'X0A 0H0', ' h0h 0h0 '])(
    'accepts %j',
    (code) => expect(isCanadianPostalCode(code)).toBe(true),
  );

  it.each([
    '90210', 'T2P 1J', 'T2P  1J9', 'D2P 1J9', 'W2P 1J9', 'Z2P 1J9', 'T2D 1J9',
    'T2P 1O9', '22P 1J9', 'T2P1J9X', '',
  ])('rejects %j', (code) => expect(isCanadianPostalCode(code)).toBe(false));

  it('normalizes to upper-case "A1A 1A1"', () => {
    expect(normalizeCanadianPostalCode('t2p1j9')).toBe('T2P 1J9');
    expect(normalizeCanadianPostalCode('t2p-1j9')).toBe('T2P 1J9');
  });
});

describe('billingAddressSchema', () => {
  it('defaults country to CA, fills line2 and normalizes', () => {
    expect(
      billingAddressSchema.parse({ ...BASE, province: 'ab', postalCode: 't2p1j9', line2: '  ' }),
    ).toEqual({
      line1: '100 8 Ave SW',
      line2: null,
      city: 'Calgary',
      province: 'AB',
      postalCode: 'T2P 1J9',
      country: 'CA',
    });
  });

  it('requires a CA province code and postal code', () => {
    expect(billingAddressSchema.safeParse({ ...BASE, province: 'Alberta' }).success).toBe(false);
    expect(billingAddressSchema.safeParse({ ...BASE, postalCode: '12345' }).success).toBe(false);
  });

  it('skips CA rules for another country', () => {
    expect(
      billingAddressSchema.parse({ ...BASE, province: 'WA', postalCode: '98101', country: 'us' }),
    ).toMatchObject({ country: 'US', province: 'WA', postalCode: '98101' });
  });

  it('rejects unknown fields and missing required ones', () => {
    expect(billingAddressSchema.safeParse({ ...BASE, extra: 1 }).success).toBe(false);
    expect(billingAddressSchema.safeParse({ ...BASE, city: '' }).success).toBe(false);
  });
});

describe('sameBillingAddress', () => {
  const a = billingAddressSchema.parse(BASE);
  it('compares structurally and null-safely', () => {
    expect(sameBillingAddress(a, { ...a })).toBe(true);
    expect(sameBillingAddress(a, { ...a, city: 'Airdrie' })).toBe(false);
    expect(sameBillingAddress(null, undefined)).toBe(true);
    expect(sameBillingAddress(a, null)).toBe(false);
  });
});
