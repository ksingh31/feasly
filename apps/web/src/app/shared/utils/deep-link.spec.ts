import { describe, expect, it } from 'vitest';
import { parseDeepLinkAddress, parseDeepLinkSource } from './deep-link';

const bounds = { minLength: 3, maxLength: 120 };

describe('parseDeepLinkAddress (#692)', () => {
  it('accepts a normal Calgary address and normalizes whitespace', () => {
    expect(parseDeepLinkAddress('  1600   15 Av SW ', bounds)).toBe('1600 15 Av SW');
  });

  it('accepts unit, ordinal, quadrant-with-dots and apostrophe forms', () => {
    expect(parseDeepLinkAddress('#225-823 5 Av N.W.', bounds)).toBe('#225-823 5 Av N.W.');
    expect(parseDeepLinkAddress("12 O'Brien Pl/Unit 4, Calgary", bounds)).toBe(
      "12 O'Brien Pl/Unit 4, Calgary",
    );
    expect(parseDeepLinkAddress('10 Rue Évangéline', bounds)).toBe('10 Rue Évangéline');
  });

  it('ignores missing, empty and too-short values', () => {
    expect(parseDeepLinkAddress(null, bounds)).toBeNull();
    expect(parseDeepLinkAddress(undefined, bounds)).toBeNull();
    expect(parseDeepLinkAddress('', bounds)).toBeNull();
    expect(parseDeepLinkAddress('  ab  ', bounds)).toBeNull();
  });

  it('ignores an over-long value, including one padded with spaces', () => {
    expect(parseDeepLinkAddress('1'.repeat(121), bounds)).toBeNull();
    expect(parseDeepLinkAddress(`1600 15 Av SW${' '.repeat(120)}`, bounds)).toBeNull();
    expect(parseDeepLinkAddress('1'.repeat(120), bounds)).toBe('1'.repeat(120));
  });

  it('ignores markup, control characters and other malformed input', () => {
    expect(parseDeepLinkAddress('<script>alert(1)</script>', bounds)).toBeNull();
    expect(parseDeepLinkAddress('1600 15 Av SW"; DROP TABLE', bounds)).toBeNull();
    expect(parseDeepLinkAddress('1600\u000015 Av SW', bounds)).toBeNull();
    expect(parseDeepLinkAddress('{{constructor}}', bounds)).toBeNull();
    expect(parseDeepLinkAddress('100%25', bounds)).toBeNull();
  });
});

describe('parseDeepLinkSource (#692)', () => {
  const allowlist = ['community-lots', 'guide'];

  it('returns the allowlisted value for a known source (case-insensitive)', () => {
    expect(parseDeepLinkSource('guide', allowlist)).toBe('guide');
    expect(parseDeepLinkSource(' Community-Lots ', allowlist)).toBe('community-lots');
  });

  it('drops unknown, empty and missing values', () => {
    expect(parseDeepLinkSource('evil<script>', allowlist)).toBeNull();
    expect(parseDeepLinkSource('guides', allowlist)).toBeNull();
    expect(parseDeepLinkSource('', allowlist)).toBeNull();
    expect(parseDeepLinkSource(null, allowlist)).toBeNull();
  });
});
