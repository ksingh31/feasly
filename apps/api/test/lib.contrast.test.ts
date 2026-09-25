/**
 * Contrast-ratio unit tests (EMB-02).
 *
 * The embed shell renders accent-colored text on light surfaces; the
 * builder-config validator warns (not fails) below 4.5:1. These pin the
 * WCAG math the warning rests on.
 */
import { describe, expect, it } from 'vitest';
import {
  contrastRatioAgainstWhite,
  MIN_ACCENT_CONTRAST,
  relativeLuminance,
} from '../src/lib/contrast';

describe('contrast', () => {
  it('anchors black at ~21 and white at 1', () => {
    expect(contrastRatioAgainstWhite('#000000')).toBeCloseTo(21, 0);
    expect(contrastRatioAgainstWhite('#ffffff')).toBeCloseTo(1, 0);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
  });

  it('rates a strong brand color above the AA threshold', () => {
    // Deep navy — comfortably readable on white.
    expect(contrastRatioAgainstWhite('#1a365d')).toBeGreaterThan(
      MIN_ACCENT_CONTRAST,
    );
  });

  it('rates the Elite brass below the AA threshold (warning case)', () => {
    // Karan's approved brass: the builder's choice, but the validator
    // must warn. Pin the value so a math regression is caught.
    const ratio = contrastRatioAgainstWhite('#B08D57');
    expect(ratio).toBeLessThan(MIN_ACCENT_CONTRAST);
    expect(ratio).toBeGreaterThan(2.5);
  });

  it('is case-insensitive on the hex digits', () => {
    expect(contrastRatioAgainstWhite('#b08d57')).toBeCloseTo(
      contrastRatioAgainstWhite('#B08D57'),
      10,
    );
  });
});
