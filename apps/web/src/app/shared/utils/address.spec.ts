import { describe, expect, it } from 'vitest';
import { isUnitLikeAddress } from './address';

describe('isUnitLikeAddress', () => {
  it('detects the City "unit street-number" shape', () => {
    expect(isUnitLikeAddress('225 823 5 Av NW')).toBe(true);
  });

  it('detects hyphenated unit forms', () => {
    expect(isUnitLikeAddress('225-823 5 Av NW')).toBe(true);
    expect(isUnitLikeAddress('4 – 1234 17 Av SW')).toBe(true);
  });

  it('detects worded unit markers', () => {
    expect(isUnitLikeAddress('Unit 225, 823 5 Av NW')).toBe(true);
    expect(isUnitLikeAddress('Apt 4, 1234 17 Av SW')).toBe(true);
    expect(isUnitLikeAddress('Suite 100 555 8 Av SW')).toBe(true);
    expect(isUnitLikeAddress('#225 823 5 Av NW')).toBe(true);
  });

  it('does not flag ordinary street addresses', () => {
    expect(isUnitLikeAddress('1600 15 Av SW')).toBe(false);
    expect(isUnitLikeAddress('123 Riverview Close SE')).toBe(false);
    expect(isUnitLikeAddress('')).toBe(false);
  });

  it('does not flag street names containing unit-like words mid-address', () => {
    // "Unit" as a street-name word without a following number is not a unit marker.
    expect(isUnitLikeAddress('123 Unity Place NW')).toBe(false);
  });
});
