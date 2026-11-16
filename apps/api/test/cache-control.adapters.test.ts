/**
 * Cache-Control coverage for Function adapters (#795, ASVS 8.2.1 / F-7).
 *
 * `securityHeaders()` carries `Cache-Control: no-store`, so every response
 * that spreads it is uncacheable by default. These source scans fail the PR
 * when:
 *  1. an adapter builds `context.res` without spreading `securityHeaders()`
 *     (the response would be cacheable and miss the other security headers);
 *  2. an adapter sets its own `Cache-Control` BEFORE the spread (the spread
 *     would silently overwrite it — or worse, a public override would be lost);
 *  3. a response opts into `public` caching outside the reviewed allowlist.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const FUNCTIONS = join(__dirname, '..', 'src', 'functions');

/** Public, non-personal responses allowed to be cached (reviewed). */
// communities-lots.ts (#691): public City open data (vacant-lot list), no
// visitor data; refreshed weekly.
const PUBLIC_CACHE_ALLOWLIST = new Set(['openapi.ts', 'zoning-districts.ts', 'communities-lots.ts']);

function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** The `{ … }` literal assigned to each `context.res`, brace-balanced. */
function responseLiterals(src: string): string[] {
  const out: string[] = [];
  const re = /context\.res\s*=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

const files = allTsFiles(FUNCTIONS).map((full) => ({
  name: relative(FUNCTIONS, full).split(sep).join('/'),
  literals: responseLiterals(stripComments(readFileSync(full, 'utf8'))),
}));

describe('adapter Cache-Control coverage (#795)', () => {
  it('finds the adapters (scanner sanity check)', () => {
    const total = files.reduce((n, f) => n + f.literals.length, 0);
    expect(total).toBeGreaterThan(50);
  });

  it('every context.res spreads securityHeaders() (default no-store)', () => {
    const offenders = files.flatMap((f) =>
      f.literals.filter((l) => !l.includes('securityHeaders()')).map(() => f.name),
    );
    expect(offenders).toEqual([]);
  });

  it('explicit Cache-Control comes after the securityHeaders() spread', () => {
    const offenders = files.flatMap((f) =>
      f.literals
        .filter((l) => {
          const cc = l.indexOf("'Cache-Control'");
          return cc !== -1 && cc < l.indexOf('securityHeaders()');
        })
        .map(() => f.name),
    );
    expect(offenders).toEqual([]);
  });

  it('only allowlisted public endpoints opt into public caching', () => {
    const publicCachers = files
      .filter((f) => f.literals.some((l) => /'Cache-Control':\s*[`'"]public/.test(l)))
      .map((f) => f.name);
    expect(publicCachers.filter((n) => !PUBLIC_CACHE_ALLOWLIST.has(n))).toEqual([]);
  });
});
