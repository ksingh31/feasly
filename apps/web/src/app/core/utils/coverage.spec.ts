import { describe, expect, it } from 'vitest';
import { detectCoverageSignal } from './coverage';

/**
 * Coverage-heuristic tests (frontend port of apps/api/src/lib/coverage.ts).
 *
 * The heuristic is deliberately conservative: ambiguous input must return
 * 'ambiguous' so callers fall back to the generic not-found copy rather than
 * wrongly telling a Calgarian they're out of coverage.
 */
describe('detectCoverageSignal', () => {
  describe('calgary signals', () => {
    it.each([
      'T2X 1A1',
      't2x1a1',
      'T3B 2K7',
      '123 Main St, Calgary, AB T2P 3C8',
      '1600 90 AV SW Calgary',
    ])('"%s" → calgary', (input) => {
      expect(detectCoverageSignal(input)).toBe('calgary');
    });
  });

  describe('out-of-coverage signals', () => {
    it.each([
      'V6B 1A1',
      'v6b1a1',
      'M5V 3A8',
      'K1A 0B1',
      'T5J 0X1', // Edmonton FSA — not Calgary
      '100 Queen St W, Toronto',
      '456 Robson St, Vancouver',
      '789 Whyte Ave, Edmonton',
      'Edmonton',
    ])('"%s" → out-of-coverage', (input) => {
      expect(detectCoverageSignal(input)).toBe('out-of-coverage');
    });
  });

  describe('ambiguous (conservative fallback)', () => {
    it.each([
      '',
      '   ',
      '16 ave',
      '918 16 AVE NW',
      '2631 63 AV SW',
      'Main Street',
      'T2', // partial postal code — not enough signal
    ])('"%s" → ambiguous', (input) => {
      expect(detectCoverageSignal(input)).toBe('ambiguous');
    });
  });

  describe('precedence', () => {
    it('an explicit Calgary signal wins over a conflicting city token', () => {
      expect(detectCoverageSignal('123 Edmonton Tr, Calgary')).toBe('calgary');
    });
  });
});
