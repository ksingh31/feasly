import { describe, expect, it } from 'vitest';
import { noResultsHintKind } from './address-query-hint';

describe('noResultsHintKind (#701)', () => {
  it.each([
    ['T2T 0X5', 'postal_code'],
    ['t2t0x5', 'postal_code'],
    ['T2T 0X5, Calgary, AB', 'postal_code'],
    ['#201 1234 17 Ave SW', 'unit'],
    ['201-1234 17 Ave SW', 'unit'],
    ['Unit 201 1234 17 Ave SW', 'unit'],
    ['Suite 5, 1234 17 Ave SW', 'unit'],
    ['1234 17 Ave SW #201', 'unit'],
    ['1234 17 Ave SW apt 3B', 'unit'],
    ['prospect av', 'no_house_number'],
    ['Prospect Avenue SW', 'no_house_number'],
    ['1412 Prospect Av SW', 'generic'],
    ['2 66 Beny-Sur-Mer Rd SW', 'generic'],
    ['', 'generic'],
  ])('"%s" → %s', (query, kind) => {
    expect(noResultsHintKind(query)).toBe(kind);
  });
});
