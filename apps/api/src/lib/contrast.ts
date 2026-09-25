/**
 * WCAG 2.x contrast-ratio helpers (EMB-02).
 *
 * Pure functions: hex in, number out. Used by builder-config validation to
 * warn (not fail) when a builder's accent color has poor contrast against
 * white — the embed shell renders accent text on light surfaces.
 */

/** Relative luminance of a #rrggbb color, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const channel = (offset: number): number => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  );
}

/**
 * WCAG contrast ratio of a #rrggbb color against white, 1 (no contrast)
 * to 21 (black on white). 4.5 is the AA threshold for normal text.
 */
export function contrastRatioAgainstWhite(hex: string): number {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

/** Minimum contrast the embed UI wants for accent-colored text on white. */
export const MIN_ACCENT_CONTRAST = 4.5;
