/**
 * check-scss-colours.test.mjs — #494: prove the feature-SCSS colour gate bites
 * and that the allowlist can only shrink.
 *
 * Run: vitest run tools/check-scss-colours.test.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST,
  compareToBaseline,
  findColourLiterals,
  formatAllowlist,
  parseAllowlist,
  scanFeatures,
} from './check-scss-colours.mjs';

describe('findColourLiterals', () => {
  it('flags hex literals of every length', () => {
    const scss = '.a { color: #fff; background: #a1b2c3; border-color: #a1b2c3cc; fill: #abcd; }';
    expect(findColourLiterals(scss)).toEqual(['#fff', '#a1b2c3', '#a1b2c3cc', '#abcd']);
  });

  it('flags numeric rgb/rgba/hsl/hsla calls', () => {
    const scss = `.a {
      color: rgb(1, 2, 3);
      box-shadow: 0 1px 2px rgba(28, 25, 20, .18);
      background: HSL(120 50% 50%);
      outline-color: hsla(.5turn, 10%, 10%, 0.5);
    }`;
    expect(findColourLiterals(scss)).toHaveLength(4);
  });

  it('flags SCSS variables and var() fallbacks — colours belong in styles.scss', () => {
    expect(findColourLiterals('$brand: #123456;')).toEqual(['#123456']);
    expect(findColourLiterals('.a { color: var(--text, #222); }')).toEqual(['#222']);
  });

  it('allows tokens and keyword colours', () => {
    const scss = `.a {
      color: var(--status-success-fg);
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      border-color: currentColor;
      box-shadow: var(--shadow-overlay);
    }`;
    expect(findColourLiterals(scss)).toEqual([]);
  });

  it('ignores id selectors, interpolation and non-colour hashes', () => {
    const scss = `#main { color: var(--text); }
      .a #add { margin: 0; }
      .b-#{$x} { width: calc(100% - #{$gap}); }`;
    expect(findColourLiterals(scss)).toEqual([]);
  });

  it('ignores colours inside comments but not after a url()', () => {
    const scss = `/* old: #ffffff */
      // legacy rgb(0, 0, 0)
      .a { background: url(https://x.test/a.png); color: #000; }`;
    expect(findColourLiterals(scss)).toEqual(['#000']);
  });
});

describe('parseAllowlist / formatAllowlist', () => {
  it('round-trips, sorts and drops zero counts', () => {
    const text = formatAllowlist(new Map([['b.scss', 2], ['a.scss', 5], ['c.scss', 0]]));
    expect(parseAllowlist(text)).toEqual(new Map([['a.scss', 5], ['b.scss', 2]]));
    expect(text.indexOf('a.scss')).toBeLessThan(text.indexOf('b.scss'));
  });

  it('rejects malformed lines', () => {
    expect(() => parseAllowlist('a.scss')).toThrow(/malformed/);
    expect(() => parseAllowlist('a.scss -1')).toThrow(/malformed/);
  });
});

describe('compareToBaseline (the ratchet)', () => {
  const baseline = new Map([['legacy.scss', 3]]);

  it('passes when counts match the baseline and clean files are absent', () => {
    const current = new Map([['legacy.scss', 3], ['clean.scss', 0]]);
    expect(compareToBaseline(current, baseline)).toEqual({ regressions: [], stale: [] });
  });

  it('fails a new hex/rgb in a file not on the allowlist', () => {
    const { regressions } = compareToBaseline(
      new Map([['legacy.scss', 3], ['new-page.scss', 1]]),
      baseline,
    );
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatch(/new-page\.scss/);
  });

  it('fails when an allowlisted file gains a literal', () => {
    const { regressions } = compareToBaseline(new Map([['legacy.scss', 4]]), baseline);
    expect(regressions[0]).toMatch(/baseline allows 3/);
  });

  it('fails a migrated file until its baseline is lowered', () => {
    const { regressions, stale } = compareToBaseline(new Map([['legacy.scss', 1]]), baseline);
    expect(regressions).toEqual([]);
    expect(stale[0]).toMatch(/lower it to 1/);
  });

  it('fails a fully migrated file until it is removed from the allowlist', () => {
    const { stale } = compareToBaseline(new Map([['legacy.scss', 0]]), baseline);
    expect(stale[0]).toMatch(/remove it/);
  });

  it('fails an entry whose file was deleted', () => {
    const { stale } = compareToBaseline(new Map(), baseline);
    expect(stale[0]).toMatch(/no longer exists/);
  });

  it('a file removed from the allowlist while it still has literals fails', () => {
    const { regressions } = compareToBaseline(new Map([['legacy.scss', 3]]), new Map());
    expect(regressions).toHaveLength(1);
  });
});

describe('scanFeatures', () => {
  it('counts literals per .scss file recursively', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scss-colours-'));
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'a.scss'), '.a { color: #fff; background: rgb(0,0,0); }');
    writeFileSync(join(dir, 'nested', 'b.scss'), '.b { color: var(--text); }');
    writeFileSync(join(dir, 'c.ts'), "const c = '#fff';");
    const counts = new Map(
      [...scanFeatures(dir).entries()].map(([p, n]) => [p.split('/').slice(-2).join('/'), n]),
    );
    expect(counts.size).toBe(2);
    expect([...counts].find(([p]) => p.endsWith('/a.scss'))?.[1]).toBe(2);
    expect(counts.get('nested/b.scss')).toBe(0);
  });
});

describe('committed baseline', () => {
  it('matches the repo exactly (no regressions, nothing stale)', () => {
    const baseline = parseAllowlist(readFileSync(ALLOWLIST, 'utf8'));
    expect(compareToBaseline(scanFeatures(), baseline)).toEqual({ regressions: [], stale: [] });
  });
});
