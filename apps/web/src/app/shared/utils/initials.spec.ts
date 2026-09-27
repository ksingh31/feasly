import { describe, expect, it } from 'vitest';
import { initials } from './initials';

describe('initials', () => {
  it('takes the first letters of the first and last words', () => {
    expect(initials('Priya Sharma')).toBe('PS');
  });

  it('uses a single letter for one-word names', () => {
    expect(initials('Madonna')).toBe('M');
  });

  it('handles extra whitespace', () => {
    expect(initials('  Ava   Smith  ')).toBe('AS');
  });

  it('falls back to a bullet for empty names', () => {
    expect(initials('')).toBe('•');
    expect(initials('   ')).toBe('•');
  });
});
