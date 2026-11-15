import { describe, expect, it } from 'vitest';
import { formatDisplayAddress } from '../src/lib/display-address';

describe('formatDisplayAddress (#703)', () => {
  it('title-cases City dataset addresses and keeps the quadrant uppercase', () => {
    expect(formatDisplayAddress('1412 PROSPECT AV SW')).toBe('1412 Prospect Av SW');
    expect(formatDisplayAddress('918 16 AV NW')).toBe('918 16 Av NW');
  });

  it('splits slug-shaped keys on hyphens', () => {
    expect(formatDisplayAddress('710-test-st-calgary')).toBe('710 Test St Calgary');
  });

  it('returns an empty string for blank input', () => {
    expect(formatDisplayAddress('   ')).toBe('');
  });
});
