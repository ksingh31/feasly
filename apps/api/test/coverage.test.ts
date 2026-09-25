/**
 * Coverage-heuristic tests (story reno/05).
 *
 * The heuristic is deliberately conservative: ambiguous input must return
 * 'ambiguous' so callers fall back to ADDRESS_NOT_FOUND rather than wrongly
 * telling a Calgarian they're out of coverage.
 */
import { describe, expect, it } from 'vitest';
import { detectCoverageSignal } from '../src/lib/coverage';

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
      '123 King St W, Toronto',
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
      '1600 90 AV SW', // street address, no city/postal
      '123 Main Street',
      'Beltline',
    ])('"%s" → ambiguous', (input) => {
      expect(detectCoverageSignal(input)).toBe('ambiguous');
    });
  });

  it('a Calgary signal wins over a conflicting city token', () => {
    expect(detectCoverageSignal('Calgary, formerly Edmonton?? T2P 1A1')).toBe('calgary');
  });
});
