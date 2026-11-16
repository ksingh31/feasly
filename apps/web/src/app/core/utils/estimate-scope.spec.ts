import { describe, expect, it } from 'vitest';
import { fillScopePlaceholders, notIncludedItems, scopeSentenceList } from './estimate-scope';

const scope = {
  includes: [
    { key: 'hard.foundation', label: 'Foundation' },
    { key: 'hard.demolition', label: 'Demolition' },
  ],
  notIncluded: [
    { key: 'demolition', label: 'Demolition of an existing home' },
    { key: 'utilities', label: 'Utility connections (water, sewer)' },
    { key: 'gst', label: 'GST' },
  ],
} as const;

describe('estimate-scope utils (#824)', () => {
  it('drops not-included entries the engine now prices', () => {
    expect(notIncludedItems(scope).map((i) => i.key)).toEqual(['utilities', 'gst']);
  });

  it('joins labels as an in-sentence list, keeping acronyms', () => {
    expect(scopeSentenceList(notIncludedItems(scope))).toBe('utility connections (water, sewer); GST');
    expect(scopeSentenceList([{ key: 'a', label: 'Foundation' }])).toBe('foundation');
    expect(scopeSentenceList([])).toBe('');
  });

  it('fills {includes} and {notIncluded} from the scope', () => {
    expect(fillScopePlaceholders('Covers {includes}. Not {notIncluded}.', scope)).toBe(
      'Covers foundation; demolition. Not utility connections (water, sewer); GST.',
    );
  });
});
